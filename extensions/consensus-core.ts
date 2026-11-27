/**
 * Pure decision + prompt logic for the self-contained adversarial loop.
 *
 * The loop does not use omp's advisor subsystem. After every agent turn this
 * plugin runs its own reviewer turn (`ctx.runEphemeralTurn`) against the live
 * conversation and asks one question: was the user's goal met? An unmet goal
 * becomes another continuation turn carrying the reviewer's findings. There is
 * no hand-off state: nothing ends the episode except the reviewer saying the
 * goal is met, or the operator pausing/stopping the loop.
 *
 * Everything here is pure so `test/consensus.test.ts` can drive it with
 * synthetic reviewer replies and session entries. No host imports beyond types.
 */
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export type Severity = "nit" | "concern" | "blocker";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
	nit: 0,
	concern: 1,
	blocker: 2,
};

export const SEVERITIES: readonly Severity[] = ["nit", "concern", "blocker"];

/** Custom message type the host uses for advisor notes (steered and preserved cards). */
export const ADVISOR_CUSTOM_TYPE = "advisor";

/**
 * The advisor's reserved stop call: advisor tools come from the built-in
 * catalog, so a note that starts with this token is `advise`'s agreement
 * signal, not a finding.
 */
export const STOP_SIGNAL = "[converged]";

export function isStopSignal(text: string): boolean {
	return text.trim().toLowerCase().startsWith(STOP_SIGNAL);
}

/** Session custom-entry type carrying this plugin's per-episode ledger. */
export const LEDGER_TYPE = "advisor-consensus";
/** Journal purpose for reviewer side turns. */
export const REVIEWER_PURPOSE = "adversarial-review";
/** Wall-clock cap for one reviewer turn. */
export const REVIEW_TIMEOUT_MS = 120_000;
/** Byte cap for the reviewer reply (JSON with findings can exceed /btw's 4 KiB). */
export const REVIEW_REPLY_MAX_BYTES = 65_536;
/** Output-token cap for the reviewer turn. */
export const REVIEW_MAX_TOKENS = 4_096;

export interface ConsensusConfig {
	/** Master switch. */
	enabled: boolean;
	/** Lowest finding severity that keeps the loop going. */
	minSeverity: Severity;
	/**
	 * Soft round budget. Crossing it does not stop the loop or hand the goal
	 * back: the loop keeps re-prompting under stall pressure and says so.
	 */
	maxRounds: number;
	/** Re-raises of one finding before the next round runs under stall pressure. */
	maxRepeats: number;
	/** Use advisor notes as a second findings source while the advisor is on. */
	includeAdvisor: boolean;
	/** Pin `advisor.syncBacklog` to `strict` so a review is never still in flight at settle. */
	forceSyncBacklog: boolean;
	/** Default the advisor's model to the session's live model unless it is configured. */
	useSessionModel: boolean;
	/** Toast on each round, convergence, stall, and budget crossing. */
	notify: boolean;
}

export const DEFAULT_CONFIG: ConsensusConfig = {
	/** Opt-in: the loop only runs after the user arms it. */
	enabled: false,
	minSeverity: "nit",
	maxRounds: 100,
	maxRepeats: 3,
	includeAdvisor: true,
	forceSyncBacklog: true,
	useSessionModel: true,
	notify: true,
};

/** Upper bound for `maxRounds`; the budget is advisory, not a stop condition. */
export const MAX_ROUNDS_CEILING = 100;

export interface ReviewerFinding {
	/** What is still unmet, in the reviewer's (or advisor's) words. */
	text: string;
	severity: Severity;
	/** Named roster advisor, when the finding came from the advisor subsystem. */
	advisor?: string;
}

export interface ReviewResult {
	/** The reviewer's verdict. Only `true` with no findings closes the episode. */
	goalMet: boolean;
	/** The goal as the reviewer restated it (optional, for the ledger/status). */
	goal?: string;
	/** One-line justification for the verdict. */
	summary?: string;
	findings: ReviewerFinding[];
}

export interface LedgerState {
	/** Id of the last user message the episode belongs to. */
	anchor: string;
	/** Continuations already spent on this anchor. */
	round: number;
	/** `findingKey` -> times included in a continuation. */
	seen: Record<string, number>;
	/** Stall pressure tiers reached in this episode. */
	stalls?: number;
	/** Set once the episode ended; no further rounds for this anchor. */
	settled?: "converged" | "cancelled";
}

export interface LedgerEntryData extends LedgerState {
	v: 2;
}

export type IgnoreReason = "no-review" | "settled" | "error-turn";

export interface ContinueDecision {
	kind: "continue";
	findings: ReviewerFinding[];
	round: number;
	ledger: LedgerState;
	/** Findings that already hit `maxRepeats`; drives the stall-pressure block. */
	repeated: ReviewerFinding[];
	/** The round budget was already spent before this round. */
	budgetSpent: boolean;
}

export type StopDecision =
	| { kind: "ignore"; reason: IgnoreReason; round: number }
	| { kind: "converged"; round: number; ledger: LedgerState; goal?: string }
	| ContinueDecision;

export function normalizeSeverity(value: unknown): Severity {
	if (typeof value !== "string") return "nit";
	const normalized = value.trim().toLowerCase();
	return normalized === "blocker" || normalized === "concern" ? normalized : "nit";
}

function meetsMinSeverity(severity: Severity, minimum: Severity): boolean {
	return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

/**
 * Identity for stall detection and the ledger: lowercase, NFKC, every run of
 * non-alphanumerics collapsed, so paraphrases with different punctuation still
 * count as the same finding.
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
 * fallback keeps older transcripts (and hosts that render without details)
 * usable.
 */
export function parseAdvisorContent(content: string): ReviewerFinding[] {
	const findings: ReviewerFinding[] = [];
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

function notesFromDetails(details: unknown): ReviewerFinding[] {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
	if (!("notes" in details) || !Array.isArray(details.notes)) return [];
	const findings: ReviewerFinding[] = [];
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
export function findingsFromEntry(entry: SessionEntry): ReviewerFinding[] {
	if (entry.type !== "custom_message" || entry.customType !== ADVISOR_CUSTOM_TYPE) return [];
	const fromDetails = notesFromDetails(entry.details);
	if (fromDetails.length > 0) return fromDetails;
	const content = typeof entry.content === "string" ? entry.content : "";
	return content.includes("<advisory") ? parseAdvisorContent(content) : [];
}

/**
 * Advisor notes the agent has not answered: notes that landed after the last
 * assistant message. Notes delivered before it were already visible to the
 * model while it produced that message. Stop calls are not findings.
 */
export function pendingAdvisorFindings(
	entries: readonly SessionEntry[],
	scan = scanEntries(entries),
): ReviewerFinding[] {
	const findings: ReviewerFinding[] = [];
	for (let index = scan.lastAssistant + 1; index < entries.length; index++) {
		const entry = entries[index]!;
		findings.push(...findingsFromEntry(entry).filter(finding => !isStopSignal(finding.text)));
	}
	return findings;
}

/** Advisor findings that survive the severity floor for this config. */
export function blockingAdvisorFindings(
	entries: readonly SessionEntry[],
	config: ConsensusConfig,
): ReviewerFinding[] {
	if (!config.includeAdvisor) return [];
	return pendingAdvisorFindings(entries).filter(finding => meetsMinSeverity(finding.severity, config.minSeverity));
}

/** Union by normalized text; the higher severity and an advisor label survive. */
function mergeFindings(findings: readonly ReviewerFinding[]): ReviewerFinding[] {
	const byKey = new Map<string, ReviewerFinding>();
	for (const finding of findings) {
		const key = findingKey(finding.text);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, finding);
			continue;
		}
		byKey.set(key, {
			...existing,
			...finding,
			severity:
				SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity] ? finding.severity : existing.severity,
			...(finding.advisor ?? existing.advisor ? { advisor: finding.advisor ?? existing.advisor } : {}),
		});
	}
	return [...byKey.values()];
}

function pruneSeen(seen: Record<string, number>, limit = 512): Record<string, number> {
	const keys = Object.keys(seen);
	if (keys.length <= limit) return seen;
	const kept: Record<string, number> = {};
	for (const key of keys.slice(keys.length - limit)) kept[key] = seen[key]!;
	return kept;
}

/** Concatenated text blocks of a message (user or assistant). */
function messageText(message: unknown): string {
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

/** The user's latest request: the goal the reviewer judges against. */
export function lastUserText(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message).trim();
		if (text) return text;
	}
	return undefined;
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
			text: messageText(entry.message),
			...(typeof stopReason === "string" ? { stopReason } : {}),
		};
	}
	return undefined;
}

interface EntryScan {
	/** Index of the last assistant message entry, or -1. */
	lastAssistant: number;
	/** Id of the last user message entry, or undefined. */
	lastUserEntryId: string | undefined;
	ledger: LedgerEntryData | undefined;
}

function parseSettled(value: unknown): LedgerState["settled"] | undefined {
	if (value === "converged") return "converged";
	// `escalated` is a v1 state: the goal was unmet when the episode closed.
	// Read it as closed so an upgrade cannot resurrect an old hand-off episode.
	if (value === "cancelled" || value === "escalated") return "cancelled";
	return undefined;
}

function parseLedger(data: unknown): LedgerEntryData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	if (!("v" in data) || (data.v !== 1 && data.v !== 2)) return undefined;
	if (!("anchor" in data) || typeof data.anchor !== "string") return undefined;
	if (!("round" in data) || typeof data.round !== "number" || !Number.isFinite(data.round)) return undefined;
	const seen: Record<string, number> = {};
	if ("seen" in data && typeof data.seen === "object" && data.seen !== null && !Array.isArray(data.seen)) {
		for (const [key, count] of Object.entries(data.seen)) {
			if (typeof count === "number" && Number.isFinite(count) && count > 0) seen[key] = Math.trunc(count);
		}
	}
	const stalls = "stalls" in data && typeof data.stalls === "number" && Number.isFinite(data.stalls) ? Math.max(0, Math.trunc(data.stalls)) : undefined;
	const settled = parseSettled("settled" in data ? data.settled : undefined);
	return {
		v: 2,
		anchor: data.anchor,
		round: Math.max(0, Math.trunc(data.round)),
		seen,
		...(stalls ? { stalls } : {}),
		...(settled ? { settled } : {}),
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

/** Extract the last JSON object from a balanced-brace scan. */
function balancedJson(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

function reviewPayload(reply: string): string | undefined {
	const blocks = /<review>([\s\S]*?)<\/review>/gi;
	let inner: string | undefined;
	for (const match of reply.matchAll(blocks)) inner = match[1];
	if (inner !== undefined) return inner.trim();

	const fences = /```(?:json)?\s*([\s\S]*?)```/gi;
	let fenced: string | undefined;
	for (const match of reply.matchAll(fences)) fenced = match[1];
	if (fenced !== undefined) return fenced.trim();

	// Last resort: the model ignored the wrapper but emitted a JSON object.
	return balancedJson(reply);
}

export type ReviewParse = { ok: true; result: ReviewResult } | { ok: false; reason: string };

/**
 * Parse the reviewer's reply. Only `goal_met` plus an optional findings array
 * are required; anything unparsable fails loudly so the caller can retry once
 * instead of silently treating a broken review as agreement.
 */
export function parseReview(reply: string): ReviewParse {
	const payload = reviewPayload(reply);
	if (payload === undefined) return { ok: false, reason: "no JSON object in the reviewer reply" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch (error) {
		return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "review JSON is not an object" };
	}
	const record = parsed as Record<string, unknown>;
	const verdict = record.goal_met ?? record.goalMet;
	if (typeof verdict !== "boolean") return { ok: false, reason: "missing boolean `goal_met`" };

	const findings: ReviewerFinding[] = [];
	if (Array.isArray(record.findings)) {
		for (const entry of record.findings) {
			if (typeof entry !== "object" || entry === null) continue;
			const text = "text" in entry ? entry.text : undefined;
			if (typeof text !== "string" || !text.trim()) continue;
			findings.push({
				text: text.trim(),
				severity: normalizeSeverity("severity" in entry ? entry.severity : undefined),
			});
		}
	}
	const goal = typeof record.goal === "string" && record.goal.trim() ? record.goal.trim() : undefined;
	const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : undefined;
	return {
		ok: true,
		result: {
			goalMet: verdict,
			findings,
			...(goal ? { goal } : {}),
			...(summary ? { summary } : {}),
		},
	};
}

/**
 * Decide what the settle boundary should do with the reviewer's verdict.
 *
 * Ordering matters: an errored/aborted turn never continues, a settled episode
 * never reopens, and the budget is advisory — spending it produces another round
 * with stall pressure, never a hand-off.
 */
export function decideAtStop(input: {
	entries: readonly SessionEntry[];
	config: ConsensusConfig;
	lastAssistant: { text: string; stopReason?: string } | undefined;
	review: ReviewResult | undefined;
	/** Catch-up: a late advisor note may reopen an episode the reviewer closed. */
	allowReopen?: boolean;
}): StopDecision {
	const { entries, config, lastAssistant, review } = input;
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
	// The advisor drives the loop exactly as it did before: its unanswered notes
	// are findings, and a round is spent on them without consulting the reviewer
	// (that is the "in the end" gate below). Findings filtered out by the
	// severity floor are not loop-worthy.
	const advisorFindings = blockingAdvisorFindings(entries, config);
	const reviewerFindings = review
		? review.findings.filter(finding => meetsMinSeverity(finding.severity, config.minSeverity))
		: [];
	const findings = mergeFindings([...reviewerFindings, ...advisorFindings]);

	if (findings.length === 0) {
		if (!review) return { kind: "ignore", reason: "no-review", round };
		// Either the reviewer accepted the goal, or every finding it raised was
		// below the severity floor. A bare `goal_met: false` with no findings
		// still keeps the loop alive, so it falls through.
		if (review.goalMet || review.findings.length > 0) {
			return {
				kind: "converged",
				round,
				...(review.goal ? { goal: review.goal } : {}),
				ledger: {
					anchor,
					round,
					seen: active?.seen ?? {},
					...(active?.stalls ? { stalls: active.stalls } : {}),
					settled: "converged",
				},
			};
		}
	}

	const seen = { ...(active?.seen ?? {}) };
	const repeated = findings.filter(finding => (seen[findingKey(finding.text)] ?? 0) >= config.maxRepeats);
	const stalls = (active?.stalls ?? 0) + (repeated.length > 0 ? 1 : 0);
	for (const finding of findings) {
		const key = findingKey(finding.text);
		seen[key] = (seen[key] ?? 0) + 1;
	}
	const nextRound = round + 1;
	return {
		kind: "continue",
		findings,
		round: nextRound,
		repeated,
		budgetSpent: round >= config.maxRounds,
		ledger: {
			anchor,
			round: nextRound,
			seen: pruneSeen(seen),
			...(stalls > 0 ? { stalls } : {}),
		},
	};
}

export interface ReviewerPromptOptions {
	/** Second attempt after an unparsable reply: demand machine-only output. */
	strict?: boolean;
}

/**
 * The reviewer is an independent turn over the same conversation, not the agent
 * that did the work. It defaults to "not met" and must see evidence.
 */
export function buildReviewerPrompt(goal: string | undefined, options: ReviewerPromptOptions = {}): string {
	const lines = [
		"You are the adversarial reviewer for this session. You did not produce the work you are judging.",
		"Another agent wrote the latest assistant turn; you see the same conversation it saw.",
		"",
		"Decide whether the user's goal has actually been met. The goal is the user's latest request.",
		...(goal ? ["", "<goal>", goal.replace(/\s+\n/g, "\n").trim(), "</goal>"] : []),
		"",
		"Rules:",
		"1. `goal_met: true` only when every explicit requirement of the goal is delivered and the transcript shows verification: file contents, command output, test results. A claim is not evidence.",
		"2. Treat as unmet: requirements silently dropped or narrowed, stubs/placeholders/TODOs, mocked or skipped checks, tests that cannot fail, edits that were never read back, and 'will do later' promises.",
		"3. Do not accept the agent's own self-assessment, and do not accept a rebuttal that merely restates an earlier claim. A rebuttal needs new evidence visible in the conversation.",
		"4. Do not invent requirements the user did not ask for. Pure style preferences are `nit` at most.",
		"5. If you list any finding, `goal_met` must be false. Otherwise `goal_met` must be true and `findings` empty.",
		"6. Severity: `blocker` = the goal is impossible while this is open; `concern` = a real gap; `nit` = minor.",
		"",
		"Reply with exactly one <review> block and nothing outside it:",
		"<review>",
		'{"goal_met": false, "goal": "<one line>", "summary": "<one line>", "findings": [{"severity": "blocker", "text": "<one concrete unmet requirement>"}]}',
		"</review>",
	];
	if (options.strict) {
		lines.push(
			"",
			"Your previous reply could not be parsed. Return only the <review> block with valid JSON: no markdown, no prose, no comments, no trailing commas.",
		);
	}
	return lines.join("\n");
}

/**
 * The continuation context. Deliberately a *ledger + protocol*, not a restated
 * order: findings are the reviewer's, the agent keeps the right to rebut with
 * new evidence, but must answer each item explicitly.
 */
export function buildRemediationPrompt(
	findings: readonly ReviewerFinding[],
	round: number,
	maxRounds: number,
	stall?: { tier: number; repeated: readonly ReviewerFinding[]; repeatedLimit: number },
): string {
	const lines: string[] = [
		`<adversarial-review round="${round}" max_rounds="${maxRounds}">`,
		"An independent reviewer judged the goal NOT met after your last turn.",
		round > maxRounds
			? `This is past the soft round budget (${maxRounds}); keep working, the loop does not hand off.`
			: `Round ${round} of a soft ${maxRounds}-round budget; the loop continues while the goal is unmet.`,
	];
	if (findings.length === 0) {
		lines.push(
			"",
			"The reviewer returned no itemized findings but did not accept the goal as met.",
			"Re-read the user's request, identify what is still missing, and close it in this turn.",
		);
	} else {
		lines.push(
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
			"file:line, command output, a spec quote. The reviewer already rejected the reply it is reviewing,",
			"so repeating the same claim without new evidence is not a rebuttal.",
		);
	}
	lines.push(
		"",
		"Report per item, and do not claim the loop is over — the reviewer decides that:",
		...findings.map((_finding, index) => `${index + 1}: fixed | rebutted | blocked — one line of evidence`),
	);
	if (stall && stall.repeated.length > 0) {
		lines.push(
			"",
			`<stall tier="${stall.tier}">`,
			`The reviewer has raised these items ${stall.repeatedLimit}+ times without accepting them:`,
			...stall.repeated.map(finding => `- ${finding.text.replace(/\s+/g, " ").trim()}`),
			"Repetition is failure. Do not restate the previous claim. State what the last attempt missed,",
			"then take a different concrete action: read the failing artifact, run the check, change the",
			"implementation. If you are blocked, name the exact missing input and everything you tried.",
			"</stall>",
		);
	}
	if (round > maxRounds) {
		lines.push(
			"",
			`<budget>Round ${round} exceeds the soft budget of ${maxRounds}. The loop continues because the goal is unmet.`,
			"If the goal is genuinely blocked, say exactly what is missing and what you tried; do not pad the turn.",
			"</budget>",
		);
	}
	lines.push("</adversarial-review>");
	return lines.join("\n");
}

/** Human-facing convergence notice. */
export function buildConvergedNotice(round: number): string {
	return round === 0
		? "advisor-consensus: the reviewer found the goal met — no continuation needed."
		: `advisor-consensus: the reviewer found the goal met after ${round} round(s).`;
}

/** Human-facing round notice. */
export function buildRoundNotice(round: number, open: number, maxRounds: number): string {
	return `advisor-consensus: round ${round}/${maxRounds} — ${open} finding(s) open`;
}

/** Human-facing notice when the soft budget is spent but the goal is still unmet. */
export function buildBudgetNotice(round: number, maxRounds: number): string {
	return `advisor-consensus: soft budget of ${maxRounds} round(s) spent at round ${round}; the goal is still unmet, so the loop continues. /adversarial pause to stop.`;
}

/** Human-facing notice when stall pressure starts or grows. */
export function buildStallNotice(tier: number, findings: readonly ReviewerFinding[]): string {
	const list = findings
		.slice(0, 5)
		.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.text.trim()}`)
		.join("\n");
	const more = findings.length > 5 ? `\n… ${findings.length - 5} more` : "";
	return `advisor-consensus: stall pressure ${tier} — the reviewer repeats:\n${list}${more}`;
}

/** Human-facing notice when the reviewer reply cannot be used. */
export function buildReviewerFailedNotice(reason: string): string {
	return `advisor-consensus: the reviewer reply was unusable (${reason}); no continuation this turn. /adversarial review retries it.`;
}

/** Human-facing notice when the host lacks the reviewer API or the turn fails. */
export function buildReviewerUnavailableNotice(): string {
	return "advisor-consensus: this host does not expose ctx.runEphemeralTurn, so the loop has no reviewer. Update omp or run /adversarial off.";
}

/** Manual `/adversarial review` report. */
export function describeReview(review: ReviewResult): string {
	const verdict = review.goalMet && review.findings.length === 0 ? "met" : "NOT met";
	const head = `reviewer: goal ${verdict}${review.goal ? ` — ${review.goal}` : ""}${review.summary ? `\n${review.summary}` : ""}`;
	if (review.findings.length === 0) return head;
	return `${head}\n${review.findings
		.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.text.trim()}`)
		.join("\n")}`;
}

/** Settings resolution from untrusted lockfile values. */
export function resolveConfig(settings: Record<string, unknown>): ConsensusConfig {
	const readBool = (key: keyof ConsensusConfig, fallback: boolean): boolean => {
		const value = settings[key];
		return typeof value === "boolean" ? value : fallback;
	};
	const readInt = (key: keyof ConsensusConfig, min: number, max: number, fallback: number): number => {
		const value = settings[key];
		const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
		if (!Number.isFinite(parsed)) return fallback;
		return Math.min(max, Math.max(min, Math.trunc(parsed)));
	};
	const severityRaw = settings.minSeverity;
	const severity =
		typeof severityRaw === "string" && (SEVERITIES as readonly string[]).includes(severityRaw)
			? normalizeSeverity(severityRaw)
			: DEFAULT_CONFIG.minSeverity;
	return {
		enabled: readBool("enabled", DEFAULT_CONFIG.enabled),
		minSeverity: severity,
		maxRounds: readInt("maxRounds", 1, MAX_ROUNDS_CEILING, DEFAULT_CONFIG.maxRounds),
		maxRepeats: readInt("maxRepeats", 1, 10, DEFAULT_CONFIG.maxRepeats),
		includeAdvisor: readBool("includeAdvisor", DEFAULT_CONFIG.includeAdvisor),
		forceSyncBacklog: readBool("forceSyncBacklog", DEFAULT_CONFIG.forceSyncBacklog),
		useSessionModel: readBool("useSessionModel", DEFAULT_CONFIG.useSessionModel),
		notify: readBool("notify", DEFAULT_CONFIG.notify),
	};
}

/** Environment overrides for one process. */
export function resolveEnvConfig(env: Record<string, string | undefined>): Partial<ConsensusConfig> {
	const bool = (value: string | undefined): boolean | undefined => {
		if (value === undefined) return undefined;
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "on") return true;
		if (normalized === "0" || normalized === "false" || normalized === "off") return false;
		return undefined;
	};
	const int = (value: string | undefined): number | undefined => {
		if (value === undefined) return undefined;
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const severity = env.OMP_ADVISOR_CONSENSUS_MIN_SEVERITY?.trim();
	const repeats = int(env.OMP_ADVISOR_CONSENSUS_MAX_REPEATS);
	const rounds = int(env.OMP_ADVISOR_CONSENSUS_MAX_ROUNDS);
	const partial: Partial<ConsensusConfig> = {};
	const enabled = bool(env.OMP_ADVISOR_CONSENSUS_ENABLED);
	if (enabled !== undefined) partial.enabled = enabled;
	if (severity && (SEVERITIES as readonly string[]).includes(severity)) partial.minSeverity = normalizeSeverity(severity);
	if (rounds !== undefined) partial.maxRounds = Math.min(MAX_ROUNDS_CEILING, Math.max(1, rounds));
	if (repeats !== undefined) partial.maxRepeats = Math.min(10, Math.max(1, repeats));
	const notify = bool(env.OMP_ADVISOR_CONSENSUS_NOTIFY);
	if (notify !== undefined) partial.notify = notify;
	const includeAdvisor = bool(env.OMP_ADVISOR_CONSENSUS_INCLUDE_ADVISOR);
	if (includeAdvisor !== undefined) partial.includeAdvisor = includeAdvisor;
	const forceSync = bool(env.OMP_ADVISOR_CONSENSUS_FORCE_SYNC_BACKLOG);
	if (forceSync !== undefined) partial.forceSyncBacklog = forceSync;
	const sessionModel = bool(env.OMP_ADVISOR_CONSENSUS_USE_SESSION_MODEL);
	if (sessionModel !== undefined) partial.useSessionModel = sessionModel;
	return partial;
}
