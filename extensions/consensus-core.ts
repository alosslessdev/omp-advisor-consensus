/**
 * Pure decision logic for the advisor-consensus loop.
 *
 * The host already gives the advisor a steering channel: `concern`/`blocker`
 * notes can interrupt the agent, and an advisory card can wake a finished run.
 * But nothing makes the *agent* answer every finding and nothing decides when
 * the pair has actually converged — an advisor note that arrives after the last
 * assistant message, below `advisor.continueSeverity`, or during the immune-turn
 * window simply becomes a card the idle agent never sees.
 *
 * This module turns that into a deterministic loop:
 *
 *   1. At every settle boundary, read the branch and collect advisor notes that
 *      landed *after* the last assistant message — those are findings the agent
 *      has not answered yet.
 *   2. If any are open, ask the host for one continuation turn carrying a
 *      numbered ledger plus the closure protocol.
 *   3. On the next settle, the advisor has reviewed that reply. No new notes
 *      means agreement; new notes mean another round, bounded by `maxRounds`
 *      and a repeat/stall detector.
 *
 * Everything here is pure so `test/consensus.test.ts` can drive it with
 * synthetic session entries. No host imports beyond types.
 */
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export type Severity = "nit" | "concern" | "blocker";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
	nit: 0,
	concern: 1,
	blocker: 2,
};

export const SEVERITIES: readonly Severity[] = ["nit", "concern", "blocker"];

/** Custom message type the host uses for advisor notes (steered and preserved cards). */
export const ADVISOR_CUSTOM_TYPE = "advisor";
/** Session custom-entry type carrying this plugin's per-episode ledger. */
export const LEDGER_TYPE = "advisor-consensus";

export interface ConsensusConfig {
	/** Master switch. */
	enabled: boolean;
	/** Lowest finding severity that keeps the loop going. */
	minSeverity: Severity;
	/** Continuation turns this plugin may spend on one user prompt. */
	maxRounds: number;
	/** Times the same finding may be re-raised before the loop escalates. */
	maxRepeats: number;
	/** Pin `advisor.syncBacklog` to `strict` so "silence" really means agreement. */
	forceSyncBacklog: boolean;
	/** Default the advisor's model to the session's live model. */
	useSessionModel: boolean;
	/** Require an explicit `[converged]` call; silence alone is not agreement. */
	requireStopCall: boolean;
	/** Toast on each round / convergence / escalation. */
	notify: boolean;
}

export const DEFAULT_CONFIG: ConsensusConfig = {
	/** Opt-in: the loop only runs after the user arms it. */
	enabled: false,
	minSeverity: "nit",
	maxRounds: 100,
	maxRepeats: 3,
	forceSyncBacklog: true,
	useSessionModel: true,
	requireStopCall: true,
	notify: true,
};

/**
 * Upper bound for `maxRounds`. Rounds are driven by steered turns rather than
 * `session_stop` continuations (the host caps those at 8 per prompt), so a very
 * long adversarial exchange is possible; the cap is only a sanity limit.
 */
export const MAX_ROUNDS_CEILING = 100;

export interface AdvisorFinding {
	/** Note text, exactly as the advisor wrote it. */
	text: string;
	severity: Severity;
	/** Named roster advisor, when the note came from one. */
	advisor?: string;
}

export interface LedgerState {
	/** Id of the last user message the episode belongs to. */
	anchor: string;
	/** Continuations already spent on this anchor. */
	round: number;
	/** `findingKey` -> times included in a continuation. */
	seen: Record<string, number>;
	/** Set once the episode ended; no further rounds for this anchor. */
	settled?: "converged" | "escalated" | "cancelled";
}

export interface LedgerEntryData extends LedgerState {
	v: 1;
}

export type IgnoreReason = "no-findings" | "settled" | "error-turn";
export type EscalateReason = "rounds-exhausted" | "repeated" | "agent-open" | "advisor-silent";

export type StopDecision =
	| { kind: "ignore"; reason: IgnoreReason; round: number }
	| { kind: "converged"; round: number; ledger: LedgerState; viaStopCall?: boolean }
	| {
			kind: "escalate";
			reason: EscalateReason;
			findings: AdvisorFinding[];
			round: number;
			ledger: LedgerState;
	  }
	| { kind: "continue"; findings: AdvisorFinding[]; round: number; ledger: LedgerState };

export function normalizeSeverity(value: unknown): Severity {
	return value === "blocker" || value === "concern" ? value : "nit";
}

export function meetsMinSeverity(severity: Severity, minimum: Severity): boolean {
	return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

/**
 * The advisor's explicit stop call.
 *
 * Advisor tools are granted from the built-in catalog only, so an extension
 * cannot hand the advisor a `stop` tool. The one tool it always has is
 * `advise`; a note that opens with this token is that tool's stop call:
 * `advise(note: "[converged] every finding is fixed or soundly rebutted")`.
 */
export const STOP_SIGNAL = "[converged]";

/** Whether an advisor note is the explicit stop call rather than a finding. */
export function isStopSignal(text: string): boolean {
	return text.trim().toLowerCase().startsWith(STOP_SIGNAL);
}

/**
 * Identity for stall detection and the ledger. Mirrors the advisor emission
 * guard's normalization (lowercase, NFKC, every run of non-alphanumerics
 * collapsed) so the plugin and the advisor agree on what "the same note" is.
 */
export function findingKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function decodeEntities(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

/**
 * Parser for advisor message bodies. `details.notes` is authoritative; this
 * fallback keeps older transcripts (and any host that renders without details)
 * usable.
 */
export function parseAdvisorContent(content: string): AdvisorFinding[] {
	const findings: AdvisorFinding[] = [];
	const pattern = /<advisory([^>]*)>([\s\S]*?)<\/advisory>/g;
	for (const match of content.matchAll(pattern)) {
		const attributes = match[1] ?? "";
		const advisor = /\badvisor="([^"]*)"/.exec(attributes)?.[1];
		const severity = /\bseverity="([^"]*)"/.exec(attributes)?.[1];
		const text = decodeEntities(match[2] ?? "").trim();
		if (!text) continue;
		findings.push({
			text,
			severity: normalizeSeverity(severity),
			...(advisor ? { advisor: decodeEntities(advisor) } : {}),
		});
	}
	return findings;
}

function notesFromDetails(details: unknown): AdvisorFinding[] {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
	if (!("notes" in details) || !Array.isArray(details.notes)) return [];
	const findings: AdvisorFinding[] = [];
	for (const note of details.notes) {
		if (typeof note !== "object" || note === null) continue;
		if (!("note" in note) || typeof note.note !== "string") continue;
		const text = note.note.trim();
		if (!text) continue;
		const severity = "severity" in note ? note.severity : undefined;
		const advisor = "advisor" in note ? note.advisor : undefined;
		findings.push({
			text,
			severity: normalizeSeverity(severity),
			...(typeof advisor === "string" && advisor ? { advisor } : {}),
		});
	}
	return findings;
}

/** Advisor findings carried by one session entry, in transcript order. */
export function findingsFromEntry(entry: SessionEntry): AdvisorFinding[] {
	if (entry.type !== "custom_message" || entry.customType !== ADVISOR_CUSTOM_TYPE) return [];
	const fromDetails = notesFromDetails(entry.details);
	if (fromDetails.length > 0) return fromDetails;
	const content = typeof entry.content === "string" ? entry.content : "";
	return content.includes("<advisory") ? parseAdvisorContent(content) : [];
}

/** Concatenated text blocks of an assistant message (the model's final answer). */
export function assistantText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		if (block.text.length > 0) parts.push(block.text);
	}
	return parts.join("\n");
}

interface EntryScan {
	/** Index of the last assistant message entry, or -1. */
	lastAssistant: number;
	/** Id of the last user message entry, or undefined. */
	lastUserEntryId: string | undefined;
	ledger: LedgerEntryData | undefined;
}

function parseLedger(data: unknown): LedgerEntryData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	if (!("v" in data) || data.v !== 1) return undefined;
	if (!("anchor" in data) || typeof data.anchor !== "string") return undefined;
	if (!("round" in data) || typeof data.round !== "number" || !Number.isFinite(data.round)) return undefined;
	const seen: Record<string, number> = {};
	if ("seen" in data && typeof data.seen === "object" && data.seen !== null && !Array.isArray(data.seen)) {
		for (const [key, count] of Object.entries(data.seen)) {
			if (typeof count === "number" && Number.isFinite(count) && count > 0) seen[key] = Math.trunc(count);
		}
	}
	const settled = "settled" in data ? data.settled : undefined;
	return {
		v: 1,
		anchor: data.anchor,
		round: Math.max(0, Math.trunc(data.round)),
		seen,
		...(settled === "converged" || settled === "escalated" || settled === "cancelled" ? { settled } : {}),
	};
}

export function scanEntries(entries: readonly SessionEntry[]): EntryScan {
	let lastAssistant = -1;
	let lastUserEntryId: string | undefined;
	let ledger: LedgerEntryData | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type === "message") {
			const role = entry.message?.role;
			if (role === "assistant") lastAssistant = index;
			else if (role === "user") lastUserEntryId = entry.id;
			continue;
		}
		if (entry.type === "custom" && entry.customType === LEDGER_TYPE) ledger = parseLedger(entry.data) ?? ledger;
	}
	return { lastAssistant, lastUserEntryId, ledger };
}

/**
 * Findings the agent has not answered: advisor notes that landed after the last
 * assistant message. Notes delivered *before* it were already visible to the
 * model while it produced that message.
 */
export function pendingFindings(entries: readonly SessionEntry[], scan = scanEntries(entries)): AdvisorFinding[] {
	const findings: AdvisorFinding[] = [];
	for (let index = scan.lastAssistant + 1; index < entries.length; index++) {
		findings.push(...findingsFromEntry(entries[index]!));
	}
	return findings;
}

const VERDICT_PATTERN = /<convergence>([\s\S]*?)<\/convergence>/gi;
const VERDICT_LINE = /verdict\s*:\s*(closed|open)/i;

/**
 * The agent-side half of the agreement test. The remediation prompt asks the
 * agent to close its reply with a `<convergence>` block; an explicit
 * `verdict: open` means the agent itself does not consider the work finished,
 * so advisor silence alone must not end the episode.
 */
export function parseVerdict(text: string): "closed" | "open" | undefined {
	let block: string | undefined;
	for (const match of text.matchAll(VERDICT_PATTERN)) block = match[1];
	if (block === undefined) return undefined;
	const verdict = VERDICT_LINE.exec(block)?.[1];
	if (!verdict) return undefined;
	return verdict.toLowerCase() === "open" ? "open" : "closed";
}

function pruneSeen(seen: Record<string, number>, limit = 512): Record<string, number> {
	const keys = Object.keys(seen);
	if (keys.length <= limit) return seen;
	const kept: Record<string, number> = {};
	for (const key of keys.slice(keys.length - limit)) kept[key] = seen[key]!;
	return kept;
}

/** The run's final answer, read from the transcript instead of a live event payload. */
export function lastAssistantAnswer(
	entries: readonly SessionEntry[],
): { text: string; stopReason?: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const stopReason = "stopReason" in entry.message ? entry.message.stopReason : undefined;
		return {
			text: assistantText(entry.message),
			...(typeof stopReason === "string" ? { stopReason } : {}),
		};
	}
	return undefined;
}

export interface StopInput {
	entries: readonly SessionEntry[];
	config: ConsensusConfig;
	/** Last assistant message of the settling run. */
	lastAssistant: { text: string; stopReason?: string } | undefined;
	/**
	 * Catch-up mode: a late advisor note may reopen an episode that already
	 * converged. Cancelled and escalated episodes stay closed.
	 */
	allowReopen?: boolean;
}

/**
 * Decide what the settle boundary should do.
 *
 * Ordering matters: an errored/aborted turn never continues, a settled episode
 * never reopens, and a repeat/stall check runs before the round cap so a
 * deadlocked exchange escalates on evidence rather than on the budget alone.
 */
export function decideAtStop(input: StopInput): StopDecision {
	const { entries, config, lastAssistant } = input;
	const scan = scanEntries(entries);
	const anchor = scan.lastUserEntryId ?? scan.ledger?.anchor ?? "session";
	const active = scan.ledger && scan.ledger.anchor === anchor ? scan.ledger : undefined;
	const round = active?.round ?? 0;

	if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
		return { kind: "ignore", reason: "error-turn", round };
	}
	if (active?.settled && !(input.allowReopen === true && active.settled === "converged")) {
		return { kind: "ignore", reason: "settled", round };
	}

	const findings = pendingFindings(entries, scan).filter(finding =>
		meetsMinSeverity(finding.severity, config.minSeverity),
	);

	const stopCalls = findings.filter(finding => isStopSignal(finding.text));
	const realFindings = findings.filter(finding => !isStopSignal(finding.text));

	if (realFindings.length === 0) {
		if (stopCalls.length > 0) {
			// The advisor's stop call is authoritative and overrides the agent's
			// own verdict; a contradictory agent claim stays visible in the log.
			return {
				kind: "converged",
				round,
				ledger: { anchor, round, seen: active?.seen ?? {}, settled: "converged" },
				viaStopCall: true,
			};
		}
		if (!active) return { kind: "ignore", reason: "no-findings", round };
		if (config.requireStopCall) {
			// Strict agreement: only the advisor itself may close the episode.
			return {
				kind: "escalate",
				reason: "advisor-silent",
				findings: [],
				round,
				ledger: { anchor, round, seen: active.seen, settled: "escalated" },
			};
		}
		const converged: LedgerState = { anchor, round, seen: active.seen, settled: "converged" };
		if (parseVerdict(lastAssistant?.text ?? "") === "open") {
			// The advisor is silent but the agent says work remains: no agreement.
			return {
				kind: "escalate",
				reason: "agent-open",
				findings: [],
				round,
				ledger: { ...converged, settled: "escalated" },
			};
		}
		return { kind: "converged", round, ledger: converged };
	}
	const findings2 = realFindings;

	const seen = { ...(active?.seen ?? {}) };
	const repeated = findings2.filter(finding => (seen[findingKey(finding.text)] ?? 0) >= config.maxRepeats);
	if (repeated.length > 0) {
		return {
			kind: "escalate",
			reason: "repeated",
			findings: findings2,
			round,
			ledger: { anchor, round, seen, settled: "escalated" },
		};
	}
	if (round >= config.maxRounds) {
		return {
			kind: "escalate",
			reason: "rounds-exhausted",
			findings: findings2,
			round,
			ledger: { anchor, round, seen, settled: "escalated" },
		};
	}

	const nextRound = round + 1;
	for (const finding of findings2) {
		const key = findingKey(finding.text);
		seen[key] = (seen[key] ?? 0) + 1;
	}
	const ledger: LedgerState = { anchor, round: nextRound, seen: pruneSeen(seen) };
	return { kind: "continue", findings: findings2, round: nextRound, ledger };
}

/**
 * The continuation context. Deliberately a *ledger + protocol*, not a restated
 * order: the advisor's notes are advisory (`weigh, don't blindly obey`), so the
 * agent keeps the right to rebut, but must answer each item explicitly.
 */
export function buildRemediationPrompt(
	findings: readonly AdvisorFinding[],
	round: number,
	maxRounds: number,
): string {
	const finalRound = round >= maxRounds;
	const lines: string[] = [
		`<advisor-consensus round="${round}" max_rounds="${maxRounds}">`,
		"The advisor reviewed your last turn and left findings open. This session runs an adversarial convergence loop:",
		"the run does not settle while a finding below is unanswered. Address every item in this turn.",
		"",
		"Open findings:",
		...findings.map(
			(finding, index) =>
				`${index + 1}. [${finding.severity}]${finding.advisor ? ` advisor="${finding.advisor}"` : ""} ${finding.text
					.replace(/\s+/g, " ")
					.trim()}`,
		),
		"",
		"For each finding either fix it (and verify the fix) or rebut it with new, concrete evidence:",
		"file:line, command output, a spec quote. The advisor already rejected the reply it is reviewing,",
		"so repeating the same claim without new evidence is not a rebuttal.",
		"",
		"Close your reply with exactly this block:",
		"<convergence>",
		...findings.map((_finding, index) => `${index + 1}: fixed | rebutted | blocked — one line of evidence`),
		"verdict: closed | open",
		"</convergence>",
		"",
		"Use `verdict: closed` only when every item is fixed or soundly rebutted; `verdict: open` means you",
		"admit work remains, and the loop escalates instead of pretending to converge.",
	];
	if (finalRound) {
		lines.push(
			`This is the final round (${round} of ${maxRounds}). Findings still open when it ends are escalated to the user.`,
		);
	}
	lines.push("</advisor-consensus>");
	return lines.join("\n");
}

const ESCALATION_REASON: Record<EscalateReason, (round: number) => string> = {
	"rounds-exhausted": round => `round budget exhausted after ${round} round(s)`,
	repeated: round => `the advisor re-raised the same finding after ${round} round(s)`,
	"agent-open": () => "the agent reports open items while the advisor raised none",
	"advisor-silent": () => "the advisor stayed silent instead of calling [converged]",
};

/** Human-facing escalation notice; the advisor cards themselves hold the detail. */
export function buildEscalationNotice(
	reason: EscalateReason,
	findings: readonly AdvisorFinding[],
	round: number,
): string {
	const header = `advisor-consensus: ${ESCALATION_REASON[reason](round)}.`;
	if (reason === "advisor-silent") {
		return `${header} Add the stop-call guidance to WATCHDOG.md, or allow silence with /adversarial require-stop off.`;
	}
	if (findings.length === 0) return `${header} Stopping here for you to decide.`;
	const list = findings
		.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.text.trim()}`)
		.join("\n");
	return `${header} ${findings.length} finding(s) still open:\n${list}`;
}

/** Transient notice when the loop is armed but no advisor can produce findings. */
export function buildMissingAdvisorNotice(): string {
	return "advisor-consensus: advisor subsystem is off, so no findings can arrive. Run /advisor on (or set advisor.enabled: true) — the loop starts reacting at the next settle.";
}

/** Convergence notice for the operator. */
export function buildConvergedNotice(round: number, viaStopCall = false): string {
	if (viaStopCall) return "advisor-consensus: advisor called stop — loop closed.";
	if (round === 0) return "advisor-consensus: advisor raised no findings; nothing to converge.";
	return `advisor-consensus: converged after ${round} round(s) — advisor raised no further findings.`;
}

function asInteger(value: unknown, min: number, max: number): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
	return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Resolve settings from plugin config (`omp plugin config --set=...`) and env
 * overrides into a validated config. Unknown/garbage values fall back to
 * defaults instead of failing the session.
 */
export function resolveConfig(
	raw: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): ConsensusConfig {
	const merged: Record<string, unknown> = { ...raw };
	const envMap: Record<string, string> = {
		OMP_ADVISOR_CONSENSUS_ENABLED: "enabled",
		OMP_ADVISOR_CONSENSUS_MIN_SEVERITY: "minSeverity",
		OMP_ADVISOR_CONSENSUS_MAX_ROUNDS: "maxRounds",
		OMP_ADVISOR_CONSENSUS_MAX_REPEATS: "maxRepeats",
		OMP_ADVISOR_CONSENSUS_FORCE_SYNC_BACKLOG: "forceSyncBacklog",
		OMP_ADVISOR_CONSENSUS_USE_SESSION_MODEL: "useSessionModel",
		OMP_ADVISOR_CONSENSUS_REQUIRE_STOP_CALL: "requireStopCall",
		OMP_ADVISOR_CONSENSUS_NOTIFY: "notify",
	};
	for (const [envKey, settingKey] of Object.entries(envMap)) {
		const value = env[envKey];
		if (value === undefined || value === "") continue;
		merged[settingKey] = value;
	}

	const booleanish = (value: unknown): boolean | undefined => {
		if (typeof value === "boolean") return value;
		if (typeof value !== "string") return undefined;
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
		return undefined;
	};
	const severity = typeof merged.minSeverity === "string" ? merged.minSeverity.trim().toLowerCase() : undefined;

	return {
		enabled: booleanish(merged.enabled) ?? DEFAULT_CONFIG.enabled,
		minSeverity: (SEVERITIES as readonly string[]).includes(severity ?? "")
			? (severity as Severity)
			: DEFAULT_CONFIG.minSeverity,
		maxRounds: asInteger(merged.maxRounds, 1, MAX_ROUNDS_CEILING) ?? DEFAULT_CONFIG.maxRounds,
		maxRepeats: asInteger(merged.maxRepeats, 1, 10) ?? DEFAULT_CONFIG.maxRepeats,
		forceSyncBacklog: booleanish(merged.forceSyncBacklog) ?? DEFAULT_CONFIG.forceSyncBacklog,
		useSessionModel: booleanish(merged.useSessionModel) ?? DEFAULT_CONFIG.useSessionModel,
		requireStopCall: booleanish(merged.requireStopCall) ?? DEFAULT_CONFIG.requireStopCall,
		notify: booleanish(merged.notify) ?? DEFAULT_CONFIG.notify,
	};
}
