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
	buildRemediationPrompt,
	decideAtStop,
	DEFAULT_CONFIG,
	LEDGER_TYPE,
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
const CONFIG_CACHE_MS = 5_000;
/**
 * A note the advisor emits after the loop settled is the one class the host
 * cannot convert into a turn itself (print mode refuses, and a preserved card
 * never wakes the agent). Catch those for this long after `agent_end` and turn
 * them into a normal round, so "late" cannot mean "lost".
 */
const CATCH_UP_WINDOW_MS = 10 * 60_000;
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
	overrideEnabled: boolean | undefined;
	overrideMaxRounds: number | undefined;
	overrideMinSeverity: Severity | undefined;
	/** Paused: keep the episode and its round budget, just stop acting. */
	paused: boolean;
	/** `modelRoles.advisor` was set by the user, not by this plugin. */
	advisorRoleConfigured: boolean | undefined;
	/** Model selector this plugin pinned into `modelRoles.advisor`. */
	pinnedAdvisorModel: string | undefined;
	/** `configured` opts out of following the session model. */
	modelMode: "session" | "configured";
	/** When the current agent loop ended, for late-note catch-up. */
	endedAt: number | undefined;
	catchUpTimer: ReturnType<ExtensionContext["setTimeout"]> | undefined;
	episodeRound: number;
	convergedCount: number;
	warnedMissingAdvisor: boolean;
	warnedDisabled: boolean;
}

const states = new Map<string, SessionState>();
let configCache: { key: string; at: number; config: ConsensusConfig } | undefined;

function stateFor(sessionId: string): SessionState {
	let state = states.get(sessionId);
	if (!state) {
		state = {
			advisorEnabled: undefined,
			syncPolicy: undefined,
			forcedSync: false,
			overrideEnabled: undefined,
			overrideMaxRounds: undefined,
			overrideMinSeverity: undefined,
			paused: false,
			advisorRoleConfigured: undefined,
			pinnedAdvisorModel: undefined,
			modelMode: "session",
			endedAt: undefined,
			catchUpTimer: undefined,
			episodeRound: 0,
			convergedCount: 0,
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

function loadConfig(cwd: string): ConsensusConfig {
	const now = Date.now();
	if (configCache && configCache.key === cwd && now - configCache.at < CONFIG_CACHE_MS) return configCache.config;
	const config = resolveConfig(readPluginSettings(cwd));
	configCache = { key: cwd, at: now, config };
	return config;
}

function effectiveConfig(cwd: string, state: SessionState): ConsensusConfig {
	const base = loadConfig(cwd);
	return {
		...base,
		enabled: state.overrideEnabled ?? base.enabled,
		maxRounds: state.overrideMaxRounds ?? base.maxRounds,
		minSeverity: state.overrideMinSeverity ?? base.minSeverity,
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

function describe(state: SessionState, config: ConsensusConfig): string {
	const advisor =
		state.advisorEnabled === true ? "on" : state.advisorEnabled === false ? "off (enable it with /advisor on)" : "unknown";
	const mode = state.paused ? "paused" : config.enabled ? "on" : "off";
	const lines = [
		`mode: ${mode}`,
		`advisor: ${advisor}`,
		`config: enabled=${config.enabled} severity>=${config.minSeverity} rounds=${config.maxRounds} repeats=${config.maxRepeats} notify=${config.notify}`,
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

		const config = effectiveConfig(ctx.cwd, state);
		const host = advisorSettings();

		const enabled = host.enabled?.get(pi.pi.settings);
		state.advisorEnabled = typeof enabled === "boolean" ? enabled : undefined;
		const sync = host.sync?.get(pi.pi.settings);
		state.syncPolicy = typeof sync === "string" ? sync : undefined;
		pi.logger.debug("advisor-consensus session_start", {
			advisorEnabled: state.advisorEnabled,
			syncBacklog: state.syncPolicy,
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
		if (state.advisorEnabled === false && !state.warnedMissingAdvisor) {
			state.warnedMissingAdvisor = true;
			ctx.ui.notify(
				"advisor-consensus: advisor subsystem is off. Enable `advisor.enabled` (or run `/advisor on`) — this plugin only loops on advisor findings.",
				"warning",
			);
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
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const state = stateFor(ctx.sessionManager.getSessionId());
		state.endedAt = Date.now();
	});

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
			state.episodeRound = 0;
			state.convergedCount++;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (config.notify) ctx.ui.notify(buildConvergedNotice(decision.round, decision.viaStopCall), "info");
			return;
		}
		if (decision.kind !== "continue") return;

		pi.appendEntry(LEDGER_TYPE, { ...decision.ledger, v: 1 } satisfies LedgerEntryData);
		state.episodeRound = decision.round;
		ctx.ui.setStatus(
			STATUS_KEY,
			`converge ${decision.round}/${config.maxRounds} · ${decision.findings.length} open`,
		);
		if (config.notify) {
			ctx.ui.notify(
				`advisor-consensus: late finding reopened round ${decision.round}/${config.maxRounds}`,
				"warning",
			);
		}
		pi.sendMessage(
			{
				customType: "advisor-consensus",
				content: buildRemediationPrompt(decision.findings, decision.round, config.maxRounds),
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
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
		if (state?.forcedSync) advisorSettings().sync?.clearOverride(pi.pi.settings);
		if (state?.pinnedAdvisorModel) advisorSettings().roles?.clearOverride(pi.pi.settings);
		states.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("session_stop", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const state = stateFor(sessionId);
		const config = effectiveConfig(ctx.cwd, state);

		if (!config.enabled || state.paused) return;
		if (state.advisorEnabled === false) return;
		if (ctx.sessionModes?.getState().plan.status === "active") return;
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
				state.episodeRound = 0;
				state.convergedCount++;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				if (config.notify) ctx.ui.notify(buildConvergedNotice(decision.round, decision.viaStopCall), "info");
				return;
			}
			case "escalate": {
				const ledger: LedgerEntryData = { ...decision.ledger, v: 1 };
				pi.appendEntry(LEDGER_TYPE, ledger);
				state.episodeRound = 0;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				if (config.notify) {
					ctx.ui.notify(buildEscalationNotice(decision.reason, decision.findings, decision.round), "warning");
				}
				return;
			}
			case "continue": {
				const ledger: LedgerEntryData = { ...decision.ledger, v: 1 };
				pi.appendEntry(LEDGER_TYPE, ledger);
				state.episodeRound = decision.round;
				ctx.ui.setStatus(
					STATUS_KEY,
					`converge ${decision.round}/${config.maxRounds} · ${decision.findings.length} open`,
				);
				if (config.notify) {
					ctx.ui.notify(
						`advisor-consensus: round ${decision.round}/${config.maxRounds} — ${decision.findings.length} finding(s) open, continuing`,
						"info",
					);
				}
				return {
					continue: true,
					additionalContext: buildRemediationPrompt(decision.findings, decision.round, config.maxRounds),
				};
			}
		}
	});

	pi.registerCommand("adversarial", {
		description: "Adversarial advisor loop: on, off (cancels mid-session), pause, resume, status",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const state = stateFor(sessionId);
			const [rawCommand = "toggle", value = ""] = args.trim().split(/\s+/);
			const config = effectiveConfig(ctx.cwd, state);

			const enable = (): void => {
				state.overrideEnabled = true;
				state.paused = false;
				ctx.ui.notify("advisor-consensus: adversarial loop on for this session.", "info");
			};

			const disable = (): void => {
				state.overrideEnabled = false;
				state.paused = false;
				state.episodeRound = 0;
				ctx.ui.setStatus(STATUS_KEY, undefined);
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

			switch (rawCommand) {
				case "status":
					ctx.ui.notify(describe(state, config), "info");
					return;
				case "on":
					enable();
					return;
				case "off":
					disable();
					return;
				case "pause":
					if (!config.enabled) {
						ctx.ui.notify("advisor-consensus: loop is off; /adversarial on to arm it.", "info");
						return;
					}
					if (state.paused) {
						ctx.ui.notify("advisor-consensus: already paused.", "info");
						return;
					}
					state.paused = true;
					ctx.ui.setStatus(STATUS_KEY, undefined);
					ctx.ui.notify(
						`advisor-consensus: paused at round ${state.episodeRound}/${config.maxRounds}; /adversarial resume to continue.`,
						"info",
					);
					return;
				case "resume":
					if (!config.enabled) {
						ctx.ui.notify("advisor-consensus: loop is off; /adversarial on to arm it.", "info");
						return;
					}
					if (!state.paused) {
						ctx.ui.notify("advisor-consensus: loop is already running.", "info");
						return;
					}
					state.paused = false;
					ctx.ui.notify(`advisor-consensus: resumed at round ${state.episodeRound}/${config.maxRounds}.`, "info");
					return;
				case "toggle":
					if (config.enabled) disable();
					else enable();
					return;
				case "max": {
					const rounds = Number.parseInt(value, 10);
					if (!Number.isFinite(rounds) || rounds < 1 || rounds > MAX_ROUNDS_CEILING) {
						ctx.ui.notify(`advisor-consensus: max must be 1..${MAX_ROUNDS_CEILING}.`, "warning");
						return;
					}
					state.overrideMaxRounds = rounds;
					ctx.ui.notify(`advisor-consensus: max rounds -> ${rounds}.`, "info");
					return;
				}
				case "severity": {
					const severity = value.toLowerCase();
					if (!(SEVERITIES as readonly string[]).includes(severity)) {
						ctx.ui.notify(`advisor-consensus: severity must be one of ${SEVERITIES.join(", ")}.`, "warning");
						return;
					}
					state.overrideMinSeverity = normalizeSeverity(severity);
					ctx.ui.notify(`advisor-consensus: minimum severity -> ${severity}.`, "info");
					return;
				}
				case "model": {
					if (value === "configured") {
						state.modelMode = "configured";
						if (state.pinnedAdvisorModel) {
							advisorSettings().roles?.clearOverride(pi.pi.settings);
							state.pinnedAdvisorModel = undefined;
						}
						ctx.ui.notify("advisor-consensus: advisor model follows the configured role.", "info");
						return;
					}
					if (value !== "session") {
						ctx.ui.notify("advisor-consensus: /adversarial model session|configured", "warning");
						return;
					}
					state.modelMode = "session";
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
					return;
				}
				case "sync": {
					const host = advisorSettings();
					if (!host.sync) {
						ctx.ui.notify("advisor-consensus: settings registry unavailable here.", "warning");
						return;
					}
					if (value === "off") {
						host.sync.clearOverride(pi.pi.settings);
						state.forcedSync = false;
						const current = host.sync.get(pi.pi.settings);
						state.syncPolicy = typeof current === "string" ? current : undefined;
						ctx.ui.notify(`advisor-consensus: released the syncBacklog pin (now ${state.syncPolicy}).`, "info");
						return;
					}
					host.sync.override(pi.pi.settings, "strict");
					state.forcedSync = true;
					state.syncPolicy = "strict";
					ctx.ui.notify("advisor-consensus: syncBacklog pinned to strict.", "info");
					return;
				}
				default:
					ctx.ui.notify(
						"advisor-consensus: /adversarial [status|on|off|pause|resume|max N|severity S|model session|model configured|sync on|off]",
						"info",
					);
			}
		},
	});
}

export { ADVISOR_CUSTOM_TYPE, DEFAULT_CONFIG };
export type { ExtensionContext };
