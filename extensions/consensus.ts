/**
 * advisor-consensus — adversarial convergence loop for omp's advisor subsystem.
 *
 * The host advisor reviews each turn and can steer the agent, but it never
 * decides when the two are *done*: a finding raised at the terminal boundary
 * below `advisor.continueSeverity`, or during the immune-turn cooldown, becomes
 * a card the idle agent never answers. This plugin closes that gap by turning
 * every unanswered advisor note into a bounded, ledgered continuation turn.
 *
 * Loop, per user prompt:
 *
 *   agent turn -> advisor review -> unanswered findings?
 *        no  -> converged, settle normally
 *        yes -> inject the ledger, continue the agent for another turn
 *
 * Agreement is two-sided: the advisor must stay silent on the next review
 * *and* the agent must not claim `verdict: open` for itself. Rounds are capped
 * (`maxRounds`) and a finding the advisor re-raises past `maxRepeats` escalates
 * to the operator instead of spinning.
 *
 * `advisor.syncBacklog` is pinned to `strict` for the session while the loop is
 * armed. Without that, the final review can still be in flight when the run
 * settles, and "no findings yet" would be mistaken for agreement.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	ADVISOR_CUSTOM_TYPE,
	scanEntries,
	lastAssistantAnswer,
	buildConvergedNotice,
	buildEscalationNotice,
	buildMissingAdvisorNotice,
	buildRemediationPrompt,
	decideAtStop,
	DEFAULT_CONFIG,
	LEDGER_TYPE,
	type AdvisorFinding,
	type ConsensusConfig,
	type LedgerEntryData,
	type LedgerState,
	type Severity,
	SEVERITIES,
	normalizeSeverity,
	resolveConfig,
	MAX_ROUNDS_CEILING,
} from "./consensus-core";

/** Package name and marketplace plugin name both key plugin settings in the lockfile. */
const SETTING_KEYS = ["omp-advisor-consensus", "advisor-consensus"] as const;
const STATUS_KEY = "advisor-consensus";
/** Session entry recording whether the user armed the loop (survives resume). */
const ARM_TYPE = "advisor-consensus-arm";
/**
 * A note the advisor emits after the loop settled is the one class the host
 * cannot convert into a turn itself (print mode refuses, and a preserved card
 * never wakes the agent). Catch those for this long after `agent_end` and turn
 * them into a normal round, so "late" cannot mean "lost".
 */
const CATCH_UP_WINDOW_MS = 10 * 60_000;
/** Host stop-hook continuations we spend before switching to steered turns (host cap: 8). */
const STOP_HOOK_ROUNDS = 6;
const CATCH_UP_DELAY_MS = 250;

interface SettingHandle {
	get(scope: unknown): unknown;
	override(scope: unknown, value: unknown): void;
	clearOverride(scope: unknown): void;
}

interface SessionState {
	advisorEnabled: boolean | undefined;
	syncPolicy: string | undefined;
	forcedSync: boolean;
	/** One attempt per session to switch the advisor on when the loop is armed. */
	advisorForceAttempted: boolean;
	forcedAdvisor: boolean;
	overrideEnabled: boolean | undefined;
	overrideMaxRounds: number | undefined;
	overrideMaxRepeats: number | undefined;
	overrideNotify: boolean | undefined;
	overrideRequireStopCall: boolean | undefined;
	refreshTimer: ReturnType<ExtensionContext["setInterval"]> | undefined;
	overrideMinSeverity: Severity | undefined;
	/** Paused: keep the episode and its round budget, just stop acting. */
	paused: boolean;
	/** `modelRoles.advisor` was set by the user, not by this plugin. */
	advisorRoleConfigured: boolean | undefined;
	/** Model selector this plugin pinned into `modelRoles.advisor`. */
	pinnedAdvisorModel: string | undefined;
	/** `configured` opts out of following the session model. */
	modelMode: "session" | "configured";
	/** Rounds already spent as host `session_stop` continuations (capped at 8). */
	stopHookRounds: number;
	stopHookAnchor: string | undefined;
	/** Round waiting for the current loop to end before it is steered in. */
	pendingRound: { round: number; findings: AdvisorFinding[]; ledger: LedgerState } | undefined;
	/** When the current agent loop ended, for late-note catch-up. */
	endedAt: number | undefined;
	catchUpTimer: ReturnType<ExtensionContext["setTimeout"]> | undefined;
	episodeRound: number;
	convergedCount: number;
	lastOpenCount: number;
	phase: "armed" | "round" | "paused" | "converged" | "escalated";
	lastStatusText: string | undefined;
	warnedMissingAdvisor: boolean;
	warnedDisabled: boolean;
}

const states = new Map<string, SessionState>();
let configCache: { key: string; stamp: string; config: ConsensusConfig } | undefined;

function stateFor(sessionId: string): SessionState {
	let state = states.get(sessionId);
	if (!state) {
		state = {
			advisorEnabled: undefined,
			syncPolicy: undefined,
			forcedSync: false,
			advisorForceAttempted: false,
			forcedAdvisor: false,
			overrideEnabled: undefined,
			overrideMaxRounds: undefined,
			overrideMaxRepeats: undefined,
			overrideNotify: undefined,
			overrideRequireStopCall: undefined,
			refreshTimer: undefined,
			overrideMinSeverity: undefined,
			paused: false,
			advisorRoleConfigured: undefined,
			pinnedAdvisorModel: undefined,
			modelMode: "session",
			stopHookRounds: 0,
			stopHookAnchor: undefined,
			pendingRound: undefined,
			endedAt: undefined,
			catchUpTimer: undefined,
			episodeRound: 0,
			convergedCount: 0,
			lastOpenCount: 0,
			phase: "armed",
			lastStatusText: undefined,
			warnedMissingAdvisor: false,
			warnedDisabled: false,
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
	// `Object.entries` on a bare object is typed `any`; JSON values are unknown.
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
	const config = resolveConfig(readPluginSettings(cwd));
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
		requireStopCall: state.overrideRequireStopCall ?? base.requireStopCall,
	};
}

/**
 * Host settings come from the runtime registry, not from the plugin lockfile.
 * Looked up lazily: extensions load before the settings panel mounts, and the
 * registry is a union of typed handles, so this one call site narrows both to
 * the shared structural surface instead of re-checking each variant.
 */
function advisorSettings(): {
	enabled: SettingHandle | undefined;
	sync: SettingHandle | undefined;
	roles: SettingHandle | undefined;
} {
	const enabled = lookup("advisor.enabled") as SettingHandle | undefined;
	const sync = lookup("advisor.syncBacklog") as SettingHandle | undefined;
	const roles = lookup("modelRoles") as SettingHandle | undefined;
	return { enabled, sync, roles };
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

/** Current `modelRoles` record, narrowed from the settings scope. */
function readModelRoles(handle: SettingHandle, scope: unknown): Record<string, string> {
	const roles: Record<string, string> = {};
	const value = handle.get(scope);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return roles;
	for (const [name, selector] of Object.entries(value)) {
		if (typeof selector === "string") roles[name] = selector;
	}
	return roles;
}

/**
 * Default the advisor to the session model.
 *
 * The advisor role normally resolves through the `slow` chain, which is a
 * different (usually stronger, usually slower and costlier) model than the one
 * the user is actually driving. For an adversarial loop the interesting
 * comparison is the same model arguing with itself, so pin
 * `modelRoles.advisor` to the live session model — unless the user configured
 * that role themselves or a WATCHDOG roster entry names its own model (roster
 * models win over the role and are untouched here).
 */
function syncAdvisorModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: SessionState,
	config: ConsensusConfig,
): void {
	const roles = advisorSettings().roles;
	if (!roles) return;
	if (state.advisorRoleConfigured === undefined) {
		// Per-role, not `isConfigured`: the `modelRoles` record is "configured"
		// as soon as any role is set, and most configs set `default`.
		state.advisorRoleConfigured = readModelRoles(roles, pi.pi.settings).advisor !== undefined;
	}
	const followSession = config.useSessionModel && state.modelMode === "session" && !state.advisorRoleConfigured;
	const selector = followSession && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (selector === state.pinnedAdvisorModel) return;
	if (!selector) {
		if (state.pinnedAdvisorModel) {
			roles.clearOverride(pi.pi.settings);
			state.pinnedAdvisorModel = undefined;
		}
		return;
	}
	roles.override(pi.pi.settings, { ...readModelRoles(roles, pi.pi.settings), advisor: selector });
	state.pinnedAdvisorModel = selector;
	pi.logger.debug("advisor-consensus pinned advisor model", { model: selector });
}

/** Persistent status-line text: the effective budget first, live state second. */
function statusLine(
	state: SessionState,
	config: ConsensusConfig,
	phase: "armed" | "round" | "paused" | "converged" | "escalated",
): string | undefined {
	if (!config.enabled && phase !== "paused") return undefined;
	switch (phase) {
		case "paused":
			return `adversarial paused · ${state.episodeRound}/${config.maxRounds}`;
		case "round":
			return `adversarial ${state.episodeRound}/${config.maxRounds} · ${state.lastOpenCount} open`;
		case "converged":
			return `adversarial converged · ${state.episodeRound}/${config.maxRounds}`;
		case "escalated":
			return `adversarial escalated · ${state.lastOpenCount} open`;
		default:
			return `adversarial on · ${config.maxRounds} rounds · repeats ${config.maxRepeats}`;
	}
}

/**
 * Re-read `advisor.enabled` / `advisor.syncBacklog` from the live settings.
 * Caching them from `session_start` left the plugin silently inert when the
 * user enabled the advisor mid-session with `/advisor on`.
 */
function refreshAdvisorState(
	pi: ExtensionAPI,
	state: SessionState,
): { enabled: SettingHandle | undefined; sync: SettingHandle | undefined; roles: SettingHandle | undefined } {
	const host = advisorSettings();
	const enabled = host.enabled?.get(pi.pi.settings);
	state.advisorEnabled = typeof enabled === "boolean" ? enabled : undefined;
	const sync = host.sync?.get(pi.pi.settings);
	state.syncPolicy = typeof sync === "string" ? sync : undefined;
	return host;
}

/**
 * Arming a loop with no reviewer is a no-op, so arming turns the advisor on for
 * this session (runtime override, not persisted) when it is off. One attempt per
 * session: if the user turns it back off with `/advisor off`, the plugin does
 * not fight them.
 */
function ensureAdvisor(
	pi: ExtensionAPI,
	state: SessionState,
	ctx: ExtensionContext,
	config: ConsensusConfig,
): void {
	const host = advisorSettings();
	const enabled = host.enabled?.get(pi.pi.settings);
	state.advisorEnabled = typeof enabled === "boolean" ? enabled : undefined;
	const wasOff = state.advisorEnabled === false;
	if (!config.enabled || !wasOff || state.advisorForceAttempted) return;
	state.advisorForceAttempted = true;
	if (!host.enabled) return;
	host.enabled.override(pi.pi.settings, true);
	state.forcedAdvisor = true;
	refreshAdvisorState(pi, state);
	const nowEnabled = state.advisorEnabled === true;
	pi.logger.debug("advisor-consensus forced advisor on", { advisorEnabled: nowEnabled });
	if (nowEnabled) {
		ctx.ui.notify(
			"advisor-consensus: advisor was off; enabled it for this session so the loop has a reviewer.",
			"info",
		);
	}
}

/** Render the status line for the live config, and only touch the footer when it changed. */
function updateStatus(
	ctx: ExtensionContext,
	state: SessionState,
	config: ConsensusConfig,
	phase: "armed" | "round" | "paused" | "converged" | "escalated" = state.phase,
): void {
	state.phase = phase;
	const text = statusLine(state, config, phase);
	if (text === state.lastStatusText) return;
	state.lastStatusText = text;
	ctx.ui.setStatus(STATUS_KEY, text);
}

function describe(state: SessionState, config: ConsensusConfig): string {
	const advisor =
		state.advisorEnabled === true ? "on" : state.advisorEnabled === false ? "off (enable it with /advisor on)" : "unknown";
	const mode = state.paused ? "paused" : config.enabled ? "on" : "off";
	const lines = [
		`mode: ${mode}`,
		`advisor: ${advisor}`,
		`config: enabled=${config.enabled} severity>=${config.minSeverity} rounds=${config.maxRounds} repeats=${config.maxRepeats} stop-call=${config.requireStopCall ? "required" : "optional"} notify=${config.notify}`,
		`syncBacklog: ${state.syncPolicy ?? "unknown"}${state.forcedSync ? " (pinned by this plugin)" : ""}`,
		`advisor model: ${state.pinnedAdvisorModel ?? (state.advisorRoleConfigured ? "configured role" : "session default")}`,
		`episode: round ${state.episodeRound}/${config.maxRounds}`,
		`converged this session: ${state.convergedCount}`,
	];
	return lines.join("\n");
}

export default function advisorConsensus(pi: ExtensionAPI) {
	pi.setLabel("Advisor Consensus");

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
		const host = advisorSettings();

		const enabled = host.enabled?.get(pi.pi.settings);
		state.advisorEnabled = typeof enabled === "boolean" ? enabled : undefined;
		const sync = host.sync?.get(pi.pi.settings);
		state.syncPolicy = typeof sync === "string" ? sync : undefined;
		updateStatus(ctx, state, config, "armed");
		state.refreshTimer = ctx.setInterval(() => {
			updateStatus(ctx, state, effectiveConfig(ctx.cwd, state));
		}, 2_000);
		pi.logger.debug("advisor-consensus session_start", {
			advisorEnabled: state.advisorEnabled,
			syncBacklog: state.syncPolicy,
			armed: config.enabled,
			recordedArm,
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
		ensureAdvisor(pi, state, ctx, config);
		if (state.advisorEnabled === false) {
			pi.logger.debug("advisor-consensus armed without advisor", { source: "session_start" });
			if (!state.warnedMissingAdvisor) {
				state.warnedMissingAdvisor = true;
				ctx.ui.notify(buildMissingAdvisorNotice(), "warning");
			}
			return;
		}
		if (state.advisorEnabled === true && config.forceSyncBacklog && state.syncPolicy !== "strict") {
			host.sync?.override(pi.pi.settings, "strict");
			state.syncPolicy = "strict";
			state.forcedSync = true;
			pi.logger.debug("advisor-consensus pinned advisor.syncBacklog=strict");
		}
		syncAdvisorModel(pi, ctx, state, config);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		state.endedAt = undefined;
		// The first `agent_start` can precede the user message reaching the branch,
		// so only a real prompt id can open a new stop-hook window.
		const anchor = scanEntries(ctx.sessionManager.getBranch()).lastUserEntryId;
		if (!anchor) return;
		if (state.stopHookAnchor !== undefined && state.stopHookAnchor !== anchor) state.stopHookRounds = 0;
		state.stopHookAnchor = anchor;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		state.endedAt = Date.now();
		const pending = state.pendingRound;
		if (!pending) return;
		const config = effectiveConfig(ctx.cwd, state);
		if (!config.enabled || state.paused || state.advisorEnabled === false) return;
		steerRound(state, config, pending);
	});

	/**
	 * Spend one round: persist the ledger, update the status line, and steer the
	 * next turn in.
	 *
	 * The turn is driven by a steered message, not by returning
	 * `{ continue: true }` from `session_stop` — the host caps those at 8 per
	 * user prompt, so `maxRounds` could never reach 100 that way.
	 */
	const steerRound = (
		state: SessionState,
		config: ConsensusConfig,
		decision: { round: number; findings: AdvisorFinding[]; ledger: LedgerState },
	): void => {
		pi.sendMessage(
			{
				customType: "advisor-consensus",
				content: buildRemediationPrompt(decision.findings, decision.round, config.maxRounds),
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
		decision: { round: number; findings: AdvisorFinding[]; ledger: LedgerState },
	): void => {
		pi.appendEntry(LEDGER_TYPE, { ...decision.ledger, v: 1 } satisfies LedgerEntryData);
		state.episodeRound = decision.round;
		state.lastOpenCount = decision.findings.length;
		updateStatus(ctx, state, config, "round");
		if (config.notify) {
			ctx.ui.notify(
				`advisor-consensus: round ${decision.round}/${config.maxRounds} — ${decision.findings.length} finding(s) open`,
				"info",
			);
		}
	};

	/**
	 * A note the advisor raises after the loop settled never becomes a turn on
	 * its own: a preserved card just sits in the transcript. If the loop is armed
	 * and the session is idle, reopen the episode with that note and keep going.
	 */
	const catchUpLateNote = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		if (state.catchUpTimer) return;
		const config = effectiveConfig(ctx.cwd, state);
		if (!config.enabled || state.paused || state.advisorEnabled === false) return;
		if (state.endedAt === undefined || Date.now() - state.endedAt > CATCH_UP_WINDOW_MS) return;
		if (ctx.sessionModes?.getState().plan.status === "active") return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		const entries: SessionEntry[] = ctx.sessionManager.getBranch();
		const decision = decideAtStop({
			entries,
			config,
			lastAssistant: lastAssistantAnswer(entries),
			allowReopen: true,
		});
		pi.logger.debug("advisor-consensus late-note catch-up", { decision: decision.kind, round: decision.round });
		if (decision.kind === "converged") {
			pi.appendEntry(LEDGER_TYPE, { ...decision.ledger, v: 1 } satisfies LedgerEntryData);
			state.episodeRound = decision.round;
			state.convergedCount++;
			updateStatus(ctx, state, config, "converged");
			if (config.notify) ctx.ui.notify(buildConvergedNotice(decision.round, decision.viaStopCall), "info");
			return;
		}
		if (decision.kind !== "continue") return;
		if (config.notify) {
			ctx.ui.notify(`advisor-consensus: late finding reopened round ${decision.round}/${config.maxRounds}`, "warning");
		}
		recordRound(ctx, state, config, decision);
		steerRound(state, config, decision);
	};

	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const message = event.message;
		if (message.role !== "custom" || message.customType !== ADVISOR_CUSTOM_TYPE) return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		if (state.catchUpTimer) return;
		state.catchUpTimer = ctx.setTimeout(() => {
			state.catchUpTimer = undefined;
			void catchUpLateNote(ctx);
		}, CATCH_UP_DELAY_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = states.get(ctx.sessionManager.getSessionId());
		if (state?.refreshTimer) ctx.clearTimer(state.refreshTimer);
		if (state?.forcedSync) advisorSettings().sync?.clearOverride(pi.pi.settings);
		if (state?.pinnedAdvisorModel) advisorSettings().roles?.clearOverride(pi.pi.settings);
		if (state?.forcedAdvisor) advisorSettings().enabled?.clearOverride(pi.pi.settings);
		states.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("session_stop", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const state = stateFor(sessionId);
		const config = effectiveConfig(ctx.cwd, state);

		if (!config.enabled || state.paused) return;
		const advisorWasOff = state.advisorEnabled === false;
		const host = refreshAdvisorState(pi, state);
		if (advisorWasOff && state.advisorEnabled === true) {
			pi.logger.debug("advisor-consensus advisor came online");
			if (config.notify) {
				ctx.ui.notify("advisor-consensus: advisor detected — findings now drive the loop.", "info");
			}
		}
		if (state.advisorEnabled === false) return;
		if (ctx.sessionModes?.getState().plan.status === "active") return;
		if (state.advisorEnabled === true && config.forceSyncBacklog && state.syncPolicy !== "strict") {
			host.sync?.override(pi.pi.settings, "strict");
			state.syncPolicy = "strict";
			state.forcedSync = true;
		}
		syncAdvisorModel(pi, ctx, state, config);

		const entries: SessionEntry[] = ctx.sessionManager.getBranch();
		const decision = decideAtStop({ entries, config, lastAssistant: lastAssistantAnswer(entries) });
		pi.logger.debug("advisor-consensus settle", {
			decision: decision.kind,
			round: decision.round,
			syncBacklog: state.syncPolicy,
			...(decision.kind === "converged" && decision.viaStopCall ? { viaStopCall: true } : {}),
			...(decision.kind === "continue" ? { findings: decision.findings.map(f => f.text) } : {}),
		});

		switch (decision.kind) {
			case "ignore":
				return;
			case "converged": {
				const ledger: LedgerEntryData = { ...decision.ledger, v: 1 };
				pi.appendEntry(LEDGER_TYPE, ledger);
				state.episodeRound = decision.round;
				state.convergedCount++;
				updateStatus(ctx, state, config, "converged");
				if (config.notify) ctx.ui.notify(buildConvergedNotice(decision.round, decision.viaStopCall), "info");
				return;
			}
			case "escalate": {
				const ledger: LedgerEntryData = { ...decision.ledger, v: 1 };
				pi.appendEntry(LEDGER_TYPE, ledger);
				state.episodeRound = decision.round;
				state.lastOpenCount = decision.findings.length;
				updateStatus(ctx, state, config, "escalated");
				if (config.notify) {
					ctx.ui.notify(buildEscalationNotice(decision.reason, decision.findings, decision.round), "warning");
				}
				return;
			}
			case "continue": {
				recordRound(ctx, state, config, decision);
				// The host continuation is the one driver every mode honors, but the
				// host caps them at 8 per prompt (shared with advisor continuations).
				// Past that budget the round is steered in from `agent_end` instead.
				if (state.stopHookRounds < STOP_HOOK_ROUNDS) {
					state.stopHookRounds++;
					return {
						continue: true,
						additionalContext: buildRemediationPrompt(decision.findings, decision.round, config.maxRounds),
					};
				}
				state.pendingRound = decision;
				return;
			}
		}
	});

	pi.registerCommand("adversarial", {
		description: "Adversarial advisor loop: on, off (cancels mid-session), pause, resume, status, config",
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
				refreshAdvisorState(pi, state);
				const config = effectiveConfig(ctx.cwd, state);
				ensureAdvisor(pi, state, ctx, config);
				updateStatus(ctx, state, config, "armed");
				ctx.ui.notify(
					`advisor-consensus: adversarial loop on · ${config.maxRounds} rounds · repeats ${config.maxRepeats}`,
					"info",
				);
				if (state.advisorEnabled === false) {
					// Arming without a reviewer cannot produce a single finding: say so
					// now, as a transient toast, instead of looking broken later.
					pi.logger.debug("advisor-consensus armed without advisor", { source: "command" });
					ctx.ui.notify(buildMissingAdvisorNotice(), "warning");
				}
			};

			const disable = (): void => {
				state.overrideEnabled = false;
				state.paused = false;
				state.episodeRound = 0;
				pi.appendEntry(ARM_TYPE, { armed: false });
				if (state.forcedAdvisor) {
					advisorSettings().enabled?.clearOverride(pi.pi.settings);
					state.forcedAdvisor = false;
					state.advisorEnabled = undefined;
				}
				refresh();
				const scan = scanEntries(ctx.sessionManager.getBranch());
				const anchor = scan.lastUserEntryId ?? scan.ledger?.anchor ?? "session";
				if (scan.ledger && scan.ledger.anchor === anchor && !scan.ledger.settled) {
					const ledger: LedgerEntryData = {
						v: 1,
						anchor,
						round: scan.ledger.round,
						seen: scan.ledger.seen,
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

			const applySync = (request: "strict" | "configured"): void => {
				const host = advisorSettings();
				if (!host.sync) {
					ctx.ui.notify("advisor-consensus: settings registry unavailable here.", "warning");
					return;
				}
				if (request === "strict") {
					host.sync.override(pi.pi.settings, "strict");
					state.forcedSync = true;
					state.syncPolicy = "strict";
					ctx.ui.notify("advisor-consensus: syncBacklog pinned to strict.", "info");
					return;
				}
				host.sync.clearOverride(pi.pi.settings);
				state.forcedSync = false;
				const current = host.sync.get(pi.pi.settings);
				state.syncPolicy = typeof current === "string" ? current : undefined;
				ctx.ui.notify(`advisor-consensus: released the syncBacklog pin (now ${state.syncPolicy}).`, "info");
			};

			const applyModel = (request: "session" | "configured"): void => {
				if (request === "configured") {
					state.modelMode = "configured";
					if (state.pinnedAdvisorModel) {
						advisorSettings().roles?.clearOverride(pi.pi.settings);
						state.pinnedAdvisorModel = undefined;
					}
					ctx.ui.notify("advisor-consensus: advisor model follows the configured role.", "info");
					return;
				}
				state.modelMode = "session";
				const config = effectiveConfig(ctx.cwd, state);
				if (config.useSessionModel && !state.advisorRoleConfigured) {
					syncAdvisorModel(pi, ctx, state, config);
					ctx.ui.notify(
						`advisor-consensus: advisor model follows the session (${state.pinnedAdvisorModel ?? "unresolved"}).`,
						"info",
					);
					return;
				}
				ctx.ui.notify(
					"advisor-consensus: modelRoles.advisor is configured explicitly; leave it or clear it in config.",
					"warning",
				);
			};

			const setRounds = (value: string): void => {
				const rounds = Number.parseInt(value, 10);
				if (!Number.isFinite(rounds) || rounds < 1 || rounds > MAX_ROUNDS_CEILING) {
					ctx.ui.notify(`advisor-consensus: max must be 1..${MAX_ROUNDS_CEILING}.`, "warning");
					return;
				}
				state.overrideMaxRounds = rounds;
				refresh();
				ctx.ui.notify(`advisor-consensus: max rounds -> ${rounds}.`, "info");
			};

			const setRepeats = (value: string): void => {
				const repeats = Number.parseInt(value, 10);
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

			/**
			 * Interactive editor for the live loop settings. Values are session
			 * overrides; durable values come from plugin settings.
			 */
			const configure = async (): Promise<void> => {
				for (;;) {
					const config = effectiveConfig(ctx.cwd, state);
					const model = state.pinnedAdvisorModel ?? (state.advisorRoleConfigured ? "configured role" : "session");
					const choice = await ctx.ui.select("Adversarial convergence", [
						{ label: `Max rounds: ${config.maxRounds}`, description: `Continuations per prompt (1..${MAX_ROUNDS_CEILING})` },
						{ label: `Max repeats: ${config.maxRepeats}`, description: "Re-raises of one finding before escalation (1..10)" },
						{ label: `Min severity: ${config.minSeverity}`, description: "Lowest severity that keeps the loop running" },
						{ label: `Notify: ${config.notify ? "on" : "off"}`, description: "Toast each round, convergence, and escalation" },
						{ label: `Sync backlog: ${state.syncPolicy ?? "unknown"}`, description: "Strict waits for each scheduled advisor review" },
						{ label: `Advisor model: ${model}`, description: "Session model by default" },
						{ label: "Done", description: "Keep these session values" },
					]);
					if (!choice || choice.startsWith("Done")) return;

					if (choice.startsWith("Max rounds")) {
						const answer = await ctx.ui.input(`Max rounds (1..${MAX_ROUNDS_CEILING})`, String(config.maxRounds));
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
						continue;
					}
					if (choice.startsWith("Sync backlog")) {
						const mode = await ctx.ui.select("Advisor sync backlog", [
							{ label: "strict", description: "Wait for every scheduled review; silence means agreement" },
							{ label: "configured", description: "Release the pin and use your own advisor.syncBacklog" },
						]);
						if (mode === "strict" || mode === "configured") applySync(mode);
						continue;
					}
					if (choice.startsWith("Advisor model")) {
						const mode = await ctx.ui.select("Advisor model", [
							{ label: "session", description: "Follow the model this session is running (default)" },
							{ label: "configured", description: "Use modelRoles.advisor / the WATCHDOG entry model" },
						]);
						if (mode === "session" || mode === "configured") applyModel(mode);
					}
				}
			};

			switch (rawCommand) {
				case "status":
					ctx.ui.notify(describe(state, effectiveConfig(ctx.cwd, state)), "info");
					return;
				case "on":
					enable();
					return;
				case "off":
					disable();
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
							"advisor-consensus: interactive editor is TUI-only. Use on/off/pause/resume, max N, repeats N, severity S, model session|configured, sync on|off.",
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
				case "require-stop": {
					const mode = value.toLowerCase();
					if (mode !== "on" && mode !== "off") {
						ctx.ui.notify("advisor-consensus: /adversarial require-stop on|off", "warning");
						return;
					}
					state.overrideRequireStopCall = mode === "on";
					refresh();
					ctx.ui.notify(
						mode === "on"
							? "advisor-consensus: only an explicit [converged] call closes the loop; silence escalates."
							: "advisor-consensus: advisor silence also closes the loop.",
						"info",
					);
					return;
				}
				case "model":
					if (value === "session" || value === "configured") {
						applyModel(value);
						return;
					}
					ctx.ui.notify("advisor-consensus: /adversarial model session|configured", "warning");
					return;
				case "sync":
					applySync(value === "off" ? "configured" : "strict");
					return;
				default:
					ctx.ui.notify(
						"advisor-consensus: /adversarial [status|on|off|pause|resume|config|max N|repeats N|severity S|require-stop on|off|model session|model configured|sync on|off]",
						"info",
					);
			}
		},
	});
}

export { ADVISOR_CUSTOM_TYPE, DEFAULT_CONFIG };
export type { ExtensionContext };
