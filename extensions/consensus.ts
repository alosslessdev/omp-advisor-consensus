/**
 * advisor-consensus — a self-contained adversarial loop.
 *
 * The loop does not use omp's advisor subsystem and never hands an unmet goal
 * back to the operator as an "escalation". After every main-agent turn it runs
 * its own reviewer turn (`ctx.runEphemeralTurn`) over the same conversation and
 * asks whether the user's goal was met. Unmet goals become continuation turns
 * carrying the reviewer's findings; the episode closes only when the reviewer
 * accepts the goal or the operator pauses/stops the loop.
 *
 * Per user prompt:
 *
 *   agent turn -> own reviewer turn -> goal met?
 *        yes -> converged, settle normally
 *        no  -> ledgered continuation turn, repeat
 *
 * `maxRounds` is a soft budget: crossing it raises the pressure and notifies,
 * it does not stop the loop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	buildBudgetNotice,
	buildConvergedNotice,
	buildRemediationPrompt,
	buildReviewerFailedNotice,
	buildReviewerPrompt,
	buildReviewerUnavailableNotice,
	buildRoundNotice,
	buildStallNotice,
	decideAtStop,
	describeReview,
	lastAssistantAnswer,
	lastUserText,
	LEDGER_TYPE,
	MAX_ROUNDS_CEILING,
	parseReview,
	REVIEWER_PURPOSE,
	REVIEW_MAX_TOKENS,
	REVIEW_REPLY_MAX_BYTES,
	REVIEW_TIMEOUT_MS,
	resolveConfig,
	resolveEnvConfig,
	scanEntries,
	SEVERITIES,
	type ConsensusConfig,
	type ContinueDecision,
	type LedgerEntryData,
	type LedgerState,
	type ReviewResult,
	type Severity,
	normalizeSeverity,
} from "./consensus-core";

/** Package name and marketplace plugin name both key plugin settings in the lockfile. */
const SETTING_KEYS = ["omp-advisor-consensus", "advisor-consensus"] as const;
const STATUS_KEY = "advisor-consensus";
/** Session entry recording whether the user armed the loop (survives resume). */
const ARM_TYPE = "advisor-consensus-arm";
/** Host stop-hook continuations we spend before switching to steered turns (host cap: 8). */
const STOP_HOOK_ROUNDS = 6;
type ManagedTimer = Parameters<ExtensionContext["clearTimer"]>[0];

interface SessionState {
	overrideEnabled: boolean | undefined;
	overrideMaxRounds: number | undefined;
	overrideMaxRepeats: number | undefined;
	overrideNotify: boolean | undefined;
	overrideMinSeverity: Severity | undefined;
	refreshTimer: ManagedTimer | undefined;
	/** Paused: keep the episode and its budget, just stop acting. */
	paused: boolean;
	/** Rounds already spent as host `session_stop` continuations (capped at 8). */
	stopHookRounds: number;
	stopHookAnchor: string | undefined;
	/** Round waiting for the current loop to end before it is steered in. */
	pendingRound: ContinueDecision | undefined;
	episodeRound: number;
	convergedCount: number;
	lastOpenCount: number;
	stalls: number;
	/** One budget toast per episode. */
	budgetWarned: boolean;
	phase: "armed" | "round" | "paused" | "converged";
	lastStatusText: string | undefined;
	warnedDisabled: boolean;
	warnedUnavailable: boolean;
	/** A reviewer turn is in flight; never start a second one. */
	reviewing: boolean;
}

const states = new Map<string, SessionState>();
let configCache: { key: string; stamp: string; config: ConsensusConfig } | undefined;

function stateFor(sessionId: string): SessionState {
	let state = states.get(sessionId);
	if (!state) {
		state = {
			overrideEnabled: undefined,
			overrideMaxRounds: undefined,
			overrideMaxRepeats: undefined,
			overrideNotify: undefined,
			overrideMinSeverity: undefined,
			refreshTimer: undefined,
			paused: false,
			stopHookRounds: 0,
			stopHookAnchor: undefined,
			pendingRound: undefined,
			episodeRound: 0,
			convergedCount: 0,
			lastOpenCount: 0,
			stalls: 0,
			budgetWarned: false,
			phase: "armed",
			lastStatusText: undefined,
			warnedDisabled: false,
			warnedUnavailable: false,
			reviewing: false,
		};
		states.set(sessionId, state);
	}
	return state;
}

/**
 * Candidate plugin lockfiles, widest scope first: user data root (default
 * `~/.omp/plugins`, XDG when initialized), then project overrides from the
 * farthest ancestor down to `cwd`. Later files win, matching the host's own
 * global-then-project merge.
 */
function lockfileCandidates(cwd: string): string[] {
	const files: string[] = [];
	const explicit = process.env.OMP_PLUGIN_LOCKFILE;
	if (explicit) files.push(explicit);
	const home = os.homedir();
	files.push(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"));
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) files.push(path.join(xdg, "omp", "plugins", "omp-plugins.lock.json"));

	const projectFiles: string[] = [];
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < 8; depth++) {
		projectFiles.push(path.join(dir, ".omp", "plugins", "omp-plugins.lock.json"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	files.push(...projectFiles.reverse());
	return files;
}

/**
 * The `settings` map out of a lockfile, as untrusted name/value pairs. JSON is
 * the boundary; every value is re-checked by the caller before use.
 */
function settingsBlocks(parsed: unknown): Array<[string, unknown]> {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	if (!("settings" in parsed)) return [];
	const settings = parsed.settings;
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [];
	return Object.entries(settings) as Array<[string, unknown]>;
}

/** Merge every `settings.<plugin-key>` block we can find into one raw map. */
function readPluginSettings(cwd: string): Record<string, unknown> {
	const raw: Record<string, unknown> = {};
	for (const file of lockfileCandidates(cwd)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		for (const [name, block] of settingsBlocks(parsed)) {
			if (!(SETTING_KEYS as readonly string[]).includes(name)) continue;
			if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
			for (const [setting, value] of Object.entries(block)) raw[setting] = value;
		}
	}
	return raw;
}

/**
 * Cheap change detection for the plugin lockfiles: settings edited from the TUI
 * (or another process) show up on the next status tick instead of a restart.
 */
function configStamp(cwd: string): string {
	const parts: string[] = [];
	for (const file of lockfileCandidates(cwd)) {
		try {
			const stat = fs.statSync(file);
			parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
		} catch {
			parts.push(`${file}:-`);
		}
	}
	return parts.join("|");
}

function loadConfig(cwd: string): ConsensusConfig {
	const stamp = configStamp(cwd);
	if (configCache && configCache.key === cwd && configCache.stamp === stamp) return configCache.config;
	const config = { ...resolveConfig(readPluginSettings(cwd)), ...resolveEnvConfig(process.env) };
	configCache = { key: cwd, stamp, config };
	return config;
}

function effectiveConfig(cwd: string, state: SessionState): ConsensusConfig {
	const base = loadConfig(cwd);
	return {
		...base,
		enabled: state.overrideEnabled ?? base.enabled,
		maxRounds: state.overrideMaxRounds ?? base.maxRounds,
		maxRepeats: state.overrideMaxRepeats ?? base.maxRepeats,
		minSeverity: state.overrideMinSeverity ?? base.minSeverity,
		notify: state.overrideNotify ?? base.notify,
	};
}

/**
 * Last `/adversarial on|off` decision recorded in the branch. Session-scoped
 * arming is otherwise lost on `--resume`, which makes the loop look broken in a
 * session the user had already turned on.
 */
function readArmState(entries: readonly SessionEntry[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== ARM_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || !("armed" in data)) return undefined;
		return typeof data.armed === "boolean" ? data.armed : undefined;
	}
	return undefined;
}

/** Persistent status-line text: the effective budget first, live state second. */
function statusLine(state: SessionState, config: ConsensusConfig, phase: SessionState["phase"]): string | undefined {
	if (!config.enabled && phase !== "paused") return undefined;
	const stall = state.stalls > 0 ? ` · stall ${state.stalls}` : "";
	switch (phase) {
		case "paused":
			return `adversarial paused · ${state.episodeRound}/${config.maxRounds}`;
		case "round":
			return `adversarial ${state.episodeRound}/${config.maxRounds} · ${state.lastOpenCount} open${stall}`;
		case "converged":
			return `adversarial converged · ${state.episodeRound}/${config.maxRounds}`;
		default:
			return `adversarial on · ${config.maxRounds} rounds (soft) · repeats ${config.maxRepeats}`;
	}
}

/** Render the status line for the live config, and only touch the footer when it changed. */
function updateStatus(
	ctx: ExtensionContext,
	state: SessionState,
	config: ConsensusConfig,
	phase: SessionState["phase"] = state.phase,
): void {
	state.phase = phase;
	const text = statusLine(state, config, phase);
	if (text === state.lastStatusText) return;
	state.lastStatusText = text;
	ctx.ui.setStatus(STATUS_KEY, text);
}

function describe(state: SessionState, config: ConsensusConfig, reviewerAvailable: boolean): string {
	const mode = state.paused ? "paused" : config.enabled ? "on" : "off";
	const lines = [
		`mode: ${mode}`,
		`reviewer: ${reviewerAvailable ? "own ephemeral turn (session model)" : "unavailable on this host"}`,
		`config: enabled=${config.enabled} severity>=${config.minSeverity} rounds=${config.maxRounds} (soft) repeats=${config.maxRepeats} notify=${config.notify}`,
		`episode: round ${state.episodeRound}/${config.maxRounds}${state.stalls > 0 ? ` · stall ${state.stalls}` : ""}`,
		`converged this session: ${state.convergedCount}`,
	];
	return lines.join("\n");
}

export default function advisorConsensus(pi: ExtensionAPI) {
	pi.setLabel("Adversarial Goal Loop");

	/**
	 * One reviewer turn over the live conversation. Returns `undefined` when the
	 * reply could not be used after one strict retry, so the caller settles
	 * without pretending the goal was met or unmet.
	 */
	const runReview = async (ctx: ExtensionContext, state: SessionState): Promise<ReviewResult | undefined> => {
		if (!ctx.runEphemeralTurn) {
			if (!state.warnedUnavailable) {
				state.warnedUnavailable = true;
				ctx.ui.notify(buildReviewerUnavailableNotice(), "warning");
			}
			return undefined;
		}
		const goal = lastUserText(ctx.sessionManager.getBranch());
		let failure = "reviewer returned an empty reply";
		for (let attempt = 0; attempt < 2; attempt++) {
			const controller = new AbortController();
			let timedOut = false;
			const timer = ctx.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, REVIEW_TIMEOUT_MS);
			try {
				const { replyText } = await ctx.runEphemeralTurn({
					promptText: buildReviewerPrompt(goal, attempt > 0 ? { strict: true } : {}),
					tools: false,
					maxTokens: REVIEW_MAX_TOKENS,
					replyMaxBytes: REVIEW_REPLY_MAX_BYTES,
					dedupeReply: false,
					purpose: REVIEWER_PURPOSE,
					signal: controller.signal,
				});
				failure = "reviewer returned an empty reply";
				const parsed = parseReview(typeof replyText === "string" ? replyText : "");
				if (parsed.ok) return parsed.result;
				failure = parsed.reason;
				pi.logger.debug("advisor-consensus reviewer reply did not parse", { attempt, reason: failure });
			} catch (error) {
				failure = timedOut
					? `reviewer timed out after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s`
					: error instanceof Error
						? error.message
						: String(error);
				pi.logger.debug("advisor-consensus reviewer turn failed", { attempt, reason: failure });
			} finally {
				ctx.clearTimer(timer);
			}
			// A cancelled turn has no useful retry: the session is going away.
			if (controller.signal.aborted && !timedOut) return undefined;
		}
		ctx.ui.notify(buildReviewerFailedNotice(failure), "warning");
		return undefined;
	};

	const steerRound = (state: SessionState, config: ConsensusConfig, decision: ContinueDecision): void => {
		pi.sendMessage(
			{
				customType: "advisor-consensus",
				content: buildRemediationPrompt(decision.findings, decision.round, config.maxRounds, {
					tier: decision.ledger.stalls ?? 0,
					repeated: decision.repeated,
					repeatedLimit: config.maxRepeats,
				}),
				display: false,
				attribution: "agent",
			},
			{ triggerTurn: true },
		);
		state.pendingRound = undefined;
	};

	const recordRound = (
		ctx: ExtensionContext,
		state: SessionState,
		config: ConsensusConfig,
		decision: ContinueDecision,
	): void => {
		pi.appendEntry(LEDGER_TYPE, { ...decision.ledger, v: 2 } satisfies LedgerEntryData);
		state.episodeRound = decision.round;
		state.lastOpenCount = decision.findings.length;
		state.stalls = decision.ledger.stalls ?? 0;
		updateStatus(ctx, state, config, "round");
		if (config.notify) ctx.ui.notify(buildRoundNotice(decision.round, decision.findings.length, config.maxRounds), "info");
		if (decision.repeated.length > 0 && config.notify) {
			ctx.ui.notify(buildStallNotice(state.stalls, decision.repeated), "warning");
		}
		if (decision.budgetSpent && !state.budgetWarned) {
			state.budgetWarned = true;
			ctx.ui.notify(buildBudgetNotice(decision.round, config.maxRounds), "warning");
		}
	};

	const settleConverged = (
		ctx: ExtensionContext,
		state: SessionState,
		config: ConsensusConfig,
		decision: { round: number; ledger: LedgerState },
	): void => {
		pi.appendEntry(LEDGER_TYPE, { ...decision.ledger, v: 2 } satisfies LedgerEntryData);
		state.episodeRound = decision.round;
		state.lastOpenCount = 0;
		state.convergedCount++;
		updateStatus(ctx, state, config, "converged");
		if (config.notify) ctx.ui.notify(buildConvergedNotice(decision.round), "info");
	};

	/** Manual `/adversarial review`: evaluate now and steer the next round if unmet. */
	const reviewAndAct = async (
		ctx: ExtensionContext,
		state: SessionState,
		config: ConsensusConfig,
		review: ReviewResult,
	): Promise<void> => {
		const entries = ctx.sessionManager.getBranch();
		const decision = decideAtStop({
			entries,
			config,
			lastAssistant: lastAssistantAnswer(entries),
			review,
		});
		switch (decision.kind) {
			case "ignore":
				return;
			case "converged":
				settleConverged(ctx, state, config, decision);
				return;
			case "continue":
				recordRound(ctx, state, config, decision);
				steerRound(state, config, decision);
				return;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		states.delete(sessionId);
		const state = stateFor(sessionId);
		state.episodeRound = 0;

		// `--resume` rebuilds extension state; the arm decision lives in the branch.
		const recordedArm = readArmState(ctx.sessionManager.getBranch());
		if (recordedArm !== undefined) state.overrideEnabled = recordedArm;
		const config = effectiveConfig(ctx.cwd, state);
		updateStatus(ctx, state, config, "armed");
		state.refreshTimer = ctx.setInterval(() => {
			updateStatus(ctx, state, effectiveConfig(ctx.cwd, state));
		}, 2_000);
		pi.logger.debug("advisor-consensus session_start", {
			armed: config.enabled,
			recordedArm,
			reviewer: Boolean(ctx.runEphemeralTurn),
			config,
		});

		if (!config.enabled) {
			// Opt-in by design: say so once, then stay completely out of the way.
			if (!state.warnedDisabled) {
				state.warnedDisabled = true;
				ctx.ui.notify(
					"advisor-consensus: off. Run /adversarial on for this session, or `omp plugin config --set enabled=true` to arm it.",
					"info",
				);
			}
			return;
		}
		if (!ctx.runEphemeralTurn && !state.warnedUnavailable) {
			state.warnedUnavailable = true;
			ctx.ui.notify(buildReviewerUnavailableNotice(), "warning");
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		// The first `agent_start` can precede the user message reaching the branch,
		// so only a real prompt id can open a new stop-hook window.
		const anchor = scanEntries(ctx.sessionManager.getBranch()).lastUserEntryId;
		if (!anchor) return;
		if (state.stopHookAnchor !== undefined && state.stopHookAnchor !== anchor) {
			state.stopHookRounds = 0;
			state.stalls = 0;
			state.budgetWarned = false;
		}
		state.stopHookAnchor = anchor;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		const pending = state.pendingRound;
		if (!pending) return;
		const config = effectiveConfig(ctx.cwd, state);
		if (!config.enabled || state.paused) return;
		steerRound(state, config, pending);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = states.get(ctx.sessionManager.getSessionId());
		if (state?.refreshTimer) ctx.clearTimer(state.refreshTimer);
		states.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("session_stop", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		const config = effectiveConfig(ctx.cwd, state);
		if (!config.enabled || state.paused || state.reviewing) return;
		if (ctx.sessionModes?.getState().plan.status === "active") return;

		const entries = ctx.sessionManager.getBranch();
		const lastAssistant = lastAssistantAnswer(entries);
		// Interruption and provider failures are not reviewable work.
		if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") return;
		// Do not spend a reviewer turn on an episode this anchor already closed.
		const scan = scanEntries(entries);
		const anchor = scan.lastUserEntryId ?? scan.ledger?.anchor ?? "session";
		if (scan.ledger?.anchor === anchor && scan.ledger.settled) return;

		state.reviewing = true;
		let review: ReviewResult | undefined;
		try {
			review = await runReview(ctx, state);
		} finally {
			state.reviewing = false;
		}
		if (!review) return;

		const decision = decideAtStop({ entries, config, lastAssistant, review });
		switch (decision.kind) {
			case "ignore":
				return;
			case "converged":
				settleConverged(ctx, state, config, decision);
				return;
			case "continue": {
				recordRound(ctx, state, config, decision);
				const prompt = buildRemediationPrompt(decision.findings, decision.round, config.maxRounds, {
					tier: decision.ledger.stalls ?? 0,
					repeated: decision.repeated,
					repeatedLimit: config.maxRepeats,
				});
				// The host caps stop-hook continuations at 8 per prompt, so past our
				// six the round is steered in from `agent_end` instead.
				if (state.stopHookRounds < STOP_HOOK_ROUNDS) {
					state.stopHookRounds++;
					return { continue: true, additionalContext: prompt };
				}
				state.pendingRound = decision;
				return;
			}
		}
	});

	pi.registerCommand("adversarial", {
		description: "Adversarial goal loop: on, off, pause, resume, status, review, config",
		handler: async (args, ctx) => {
			const state = stateFor(ctx.sessionManager.getSessionId());
			const [rawCommand = "toggle", value = ""] = args.trim().split(/\s+/);

			const refresh = (): void => {
				updateStatus(ctx, state, effectiveConfig(ctx.cwd, state), state.paused ? "paused" : "armed");
			};

			const enable = (): void => {
				state.overrideEnabled = true;
				state.paused = false;
				pi.appendEntry(ARM_TYPE, { armed: true });
				const config = effectiveConfig(ctx.cwd, state);
				updateStatus(ctx, state, config, "armed");
				ctx.ui.notify(
					`advisor-consensus: adversarial loop on · own reviewer · soft ${config.maxRounds} rounds · repeats ${config.maxRepeats}`,
					"info",
				);
				if (!ctx.runEphemeralTurn) {
					ctx.ui.notify(buildReviewerUnavailableNotice(), "warning");
				}
			};

			const disable = (): void => {
				state.overrideEnabled = false;
				state.paused = false;
				state.episodeRound = 0;
				state.pendingRound = undefined;
				state.stalls = 0;
				pi.appendEntry(ARM_TYPE, { armed: false });
				refresh();
				const scan = scanEntries(ctx.sessionManager.getBranch());
				const anchor = scan.lastUserEntryId ?? scan.ledger?.anchor ?? "session";
				if (scan.ledger && scan.ledger.anchor === anchor && !scan.ledger.settled) {
					const ledger: LedgerEntryData = {
						v: 2,
						anchor,
						round: scan.ledger.round,
						seen: scan.ledger.seen,
						...(scan.ledger.stalls ? { stalls: scan.ledger.stalls } : {}),
						settled: "cancelled",
					};
					pi.appendEntry(LEDGER_TYPE, ledger);
					ctx.ui.notify(
						`advisor-consensus: adversarial loop cancelled mid-episode (round ${scan.ledger.round}).`,
						"info",
					);
					return;
				}
				ctx.ui.notify("advisor-consensus: adversarial loop off for this session.", "info");
			};

			const setRounds = (input: string): void => {
				const rounds = Number.parseInt(input, 10);
				if (!Number.isFinite(rounds) || rounds < 1 || rounds > MAX_ROUNDS_CEILING) {
					ctx.ui.notify(`advisor-consensus: max must be 1..${MAX_ROUNDS_CEILING}.`, "warning");
					return;
				}
				state.overrideMaxRounds = rounds;
				refresh();
				ctx.ui.notify(`advisor-consensus: soft max rounds -> ${rounds}.`, "info");
			};

			const setRepeats = (input: string): void => {
				const repeats = Number.parseInt(input, 10);
				if (!Number.isFinite(repeats) || repeats < 1 || repeats > 10) {
					ctx.ui.notify("advisor-consensus: repeats must be 1..10.", "warning");
					return;
				}
				state.overrideMaxRepeats = repeats;
				refresh();
				ctx.ui.notify(`advisor-consensus: max repeats -> ${repeats}.`, "info");
			};

			const setSeverity = (candidate: string): void => {
				const severity = candidate.toLowerCase();
				if (!(SEVERITIES as readonly string[]).includes(severity)) {
					ctx.ui.notify(`advisor-consensus: severity must be one of ${SEVERITIES.join(", ")}.`, "warning");
					return;
				}
				state.overrideMinSeverity = normalizeSeverity(severity);
				refresh();
				ctx.ui.notify(`advisor-consensus: minimum severity -> ${severity}.`, "info");
			};

			/** Evaluate now and act on the verdict: this is the manual nudge. */
			const reviewNow = async (): Promise<void> => {
				const config = effectiveConfig(ctx.cwd, state);
				if (state.reviewing) {
					ctx.ui.notify("advisor-consensus: a reviewer turn is already running.", "info");
					return;
				}
				state.reviewing = true;
				let review: ReviewResult | undefined;
				try {
					review = await runReview(ctx, state);
				} finally {
					state.reviewing = false;
				}
				if (!review) return;
				ctx.ui.notify(describeReview(review), review.goalMet && review.findings.length === 0 ? "info" : "warning");
				if (!config.enabled || state.paused) return;
				await reviewAndAct(ctx, state, config, review);
			};

			/**
			 * Interactive editor for the live loop settings. Values are session
			 * overrides; durable values come from plugin settings.
			 */
			const configure = async (): Promise<void> => {
				for (;;) {
					const config = effectiveConfig(ctx.cwd, state);
					const choice = await ctx.ui.select("Adversarial goal loop", [
						{
							label: `Soft max rounds: ${config.maxRounds}`,
							description: `Continuations per prompt before pressure rises (1..${MAX_ROUNDS_CEILING}); never stops the loop`,
						},
						{
							label: `Max repeats: ${config.maxRepeats}`,
							description: "Re-raises of one finding before stall pressure starts (1..10)",
						},
						{ label: `Min severity: ${config.minSeverity}`, description: "Lowest finding severity that keeps the loop running" },
						{ label: `Notify: ${config.notify ? "on" : "off"}`, description: "Toast each round, convergence, stall, budget" },
						{ label: "Done", description: "Keep these session values" },
					]);
					if (!choice || choice.startsWith("Done")) return;

					if (choice.startsWith("Soft max rounds")) {
						const answer = await ctx.ui.input(`Soft max rounds (1..${MAX_ROUNDS_CEILING})`, String(config.maxRounds));
						if (answer !== undefined) setRounds(answer);
						continue;
					}
					if (choice.startsWith("Max repeats")) {
						const answer = await ctx.ui.input("Max repeats (1..10)", String(config.maxRepeats));
						if (answer !== undefined) setRepeats(answer);
						continue;
					}
					if (choice.startsWith("Min severity")) {
						const severity = await ctx.ui.select(
							"Minimum severity",
							SEVERITIES.map(level => ({ label: level })),
						);
						if (severity) setSeverity(severity);
						continue;
					}
					if (choice.startsWith("Notify")) {
						state.overrideNotify = !config.notify;
						refresh();
					}
				}
			};

			switch (rawCommand) {
				case "status":
					ctx.ui.notify(describe(state, effectiveConfig(ctx.cwd, state), Boolean(ctx.runEphemeralTurn)), "info");
					return;
				case "on":
					enable();
					return;
				case "off":
					disable();
					return;
				case "review":
					await reviewNow();
					return;
				case "pause": {
					const config = effectiveConfig(ctx.cwd, state);
					if (!config.enabled) {
						ctx.ui.notify("advisor-consensus: loop is off; /adversarial on to arm it.", "info");
						return;
					}
					if (state.paused) {
						ctx.ui.notify("advisor-consensus: already paused.", "info");
						return;
					}
					state.paused = true;
					updateStatus(ctx, state, config, "paused");
					ctx.ui.notify(
						`advisor-consensus: paused at round ${state.episodeRound}/${config.maxRounds}; /adversarial resume to continue.`,
						"info",
					);
					return;
				}
				case "resume": {
					const config = effectiveConfig(ctx.cwd, state);
					if (!config.enabled) {
						ctx.ui.notify("advisor-consensus: loop is off; /adversarial on to arm it.", "info");
						return;
					}
					if (!state.paused) {
						ctx.ui.notify("advisor-consensus: loop is already running.", "info");
						return;
					}
					state.paused = false;
					updateStatus(ctx, state, config, state.episodeRound > 0 ? "round" : "armed");
					ctx.ui.notify(`advisor-consensus: resumed at round ${state.episodeRound}/${config.maxRounds}.`, "info");
					return;
				}
				case "toggle":
					if (effectiveConfig(ctx.cwd, state).enabled) disable();
					else enable();
					return;
				case "config":
					if (ctx.mode !== "tui") {
						ctx.ui.notify(
							"advisor-consensus: interactive editor is TUI-only. Use on/off/pause/resume/review, max N, repeats N, severity S.",
							"info",
						);
						return;
					}
				// fall through: TUI opens the editor below
				case "edit":
					await configure();
					return;
				case "max":
					setRounds(value);
					return;
				case "repeats":
					setRepeats(value);
					return;
				case "severity":
					setSeverity(value);
					return;
				default:
					ctx.ui.notify(
						"advisor-consensus: /adversarial [status|on|off|pause|resume|review|config|max N|repeats N|severity S]",
						"info",
					);
			}
		},
	});
}
