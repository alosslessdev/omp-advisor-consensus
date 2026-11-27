import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	buildConvergedNotice,
	buildRemediationPrompt,
	buildReviewerPrompt,
	decideAtStop,
	DEFAULT_CONFIG,
	describeReview,
	findingKey,
	lastUserText,
	LEDGER_TYPE,
	parseAdvisorContent,
	parseReview,
	pendingAdvisorFindings,
	resolveConfig,
	resolveEnvConfig,
	scanEntries,
	type ConsensusConfig,
	type ReviewResult,
} from "../extensions/consensus-core";

const TS = "2026-01-01T00:00:00.000Z";

/**
 * Fixtures are the JSON shapes the host persists (session entries); the cast is
 * the test boundary, not a claim the compiler checks.
 */
function entries(...items: unknown[]): SessionEntry[] {
	return items as SessionEntry[];
}

function user(id: string, text = "do the work") {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistant(id: string, text: string, stopReason = "stop") {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason },
	};
}

function advisorNote(id: string, notes: Array<{ note: string; severity?: string; advisor?: string }>) {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TS,
		customType: "advisor",
		content: "",
		display: true,
		details: { notes },
	};
}

function ledger(id: string, data: Record<string, unknown>) {
	return { type: "custom", id, parentId: null, timestamp: TS, customType: LEDGER_TYPE, data };
}

const config = (overrides: Partial<ConsensusConfig> = {}): ConsensusConfig => ({
	...DEFAULT_CONFIG,
	enabled: true,
	...overrides,
});

const review = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
	goalMet: true,
	findings: [],
	...overrides,
});

const notMet = (...findings: Array<{ text: string; severity?: "nit" | "concern" | "blocker" }>): ReviewResult => ({
	goalMet: false,
	findings: findings.map(finding => ({ text: finding.text, severity: finding.severity ?? "concern" })),
});

describe("reviewer reply parsing", () => {
	it("reads the wrapped JSON block and normalizes severities", () => {
		const parsed = parseReview(
			'<review>{"goal_met": false, "goal": "ship it", "summary": "one gap", "findings": [{"severity": "BLOCKER", "text": " no test "}]}</review>',
		);
		expect(parsed).toEqual({
			ok: true,
			result: {
				goalMet: false,
				goal: "ship it",
				summary: "one gap",
				findings: [{ text: "no test", severity: "blocker" }],
			},
		});
	});

	it("accepts a fenced block or a bare JSON object", () => {
		const fenced = parseReview('Here you go:\n```json\n{"goal_met": true}\n```\n');
		expect(fenced.ok && fenced.result.goalMet).toBe(true);
		const bare = parseReview('Verdict: {"goal_met": false, "findings": []} — done.');
		expect(bare.ok && bare.result.goalMet).toBe(false);
	});

	it("rejects an unusable reply instead of guessing", () => {
		expect(parseReview("")).toMatchObject({ ok: false });
		expect(parseReview("looks good to me")).toMatchObject({ ok: false });
		expect(parseReview("<review>{not json}</review>")).toMatchObject({ ok: false });
		expect(parseReview('<review>{"findings": []}</review>')).toMatchObject({ ok: false });
	});

	it("skips malformed findings but keeps the verdict", () => {
		const parsed = parseReview(
			'<review>{"goal_met": false, "findings": [{"text": "  "}, {"severity": "concern"}, {"text": "real gap"}]}</review>',
		);
		expect(parsed.ok && parsed.result.findings).toEqual([{ text: "real gap", severity: "nit" }]);
	});
});

describe("decision at the settle boundary", () => {
	it("converges only when the reviewer accepts the goal", () => {
		const branch = entries(user("u1"), ledger("l1", { v: 2, anchor: "u1", round: 1, seen: { x: 1 } }), assistant("a1", "ok"));
		expect(decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "ok" }, review: review() })).toEqual({
			kind: "converged",
			round: 1,
			ledger: { anchor: "u1", round: 1, seen: { x: 1 }, settled: "converged" },
		});
	});

	it("continues with a ledgered round when findings remain", () => {
		const branch = entries(user("u1"), assistant("a1", "done"));
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done" },
			review: notMet({ text: "missing test" }),
		});
		expect(decision).toEqual({
			kind: "continue",
			findings: [{ text: "missing test", severity: "concern" }],
			round: 1,
			repeated: [],
			budgetSpent: false,
			ledger: { anchor: "u1", round: 1, seen: { "missing test": 1 } },
		});
	});

	it("treats findings as unmet even when the verdict claims success", () => {
		const branch = entries(user("u1"), assistant("a1", "done"));
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done" },
			review: review({ findings: [{ text: "still broken", severity: "blocker" }] }),
		});
		expect(decision.kind).toBe("continue");
	});

	it("keeps looping on a bare unmet verdict with no itemized findings", () => {
		const branch = entries(user("u1"), assistant("a1", "done"));
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done" },
			review: review({ goalMet: false }),
		});
		expect(decision).toMatchObject({ kind: "continue", findings: [], round: 1 });
	});

	it("drops findings below the severity floor", () => {
		const branch = entries(user("u1"), assistant("a1", "done"));
		const decision = decideAtStop({
			entries: branch,
			config: config({ minSeverity: "concern" }),
			lastAssistant: { text: "done" },
			review: review({ goalMet: false, findings: [{ text: "rename it", severity: "nit" }] }),
		});
		expect(decision.kind).toBe("converged");
	});

	it("ignores an episode that already settled, an error turn, and a missing review", () => {
		const settled = entries(
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {}, settled: "converged" }),
			assistant("a1", "done"),
		);
		expect(decideAtStop({ entries: settled, config: config(), lastAssistant: { text: "done" }, review: review() })).toEqual({
			kind: "ignore",
			reason: "settled",
			round: 2,
		});

		const aborted = entries(user("u1"), assistant("a1", "interrupted", "aborted"));
		expect(
			decideAtStop({ entries: aborted, config: config(), lastAssistant: { text: "", stopReason: "aborted" }, review: notMet({ text: "x" }) }),
		).toEqual({ kind: "ignore", reason: "error-turn", round: 0 });

		const clean = entries(user("u1"), assistant("a1", "done"));
		expect(decideAtStop({ entries: clean, config: config(), lastAssistant: { text: "done" }, review: undefined })).toEqual({
			kind: "ignore",
			reason: "no-review",
			round: 0,
		});
	});

	it("raises stall pressure once a finding repeats past the limit", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 3, seen: { "missing test": 3 }, stalls: 1 }),
			assistant("a1", "done"),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config({ maxRepeats: 3 }),
			lastAssistant: { text: "done" },
			review: notMet({ text: "Missing test!" }),
		});
		expect(decision).toMatchObject({
			kind: "continue",
			round: 4,
			repeated: [{ text: "Missing test!", severity: "concern" }],
			ledger: { stalls: 2, seen: { "missing test": 4 } },
		});
	});

	it("keeps going past the soft budget instead of handing off", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {} }),
			assistant("a1", "done"),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config({ maxRounds: 2 }),
			lastAssistant: { text: "done" },
			review: notMet({ text: "still broken" }),
		});
		expect(decision).toMatchObject({ kind: "continue", round: 3, budgetSpent: true });
	});

	it("reads a legacy v1 escalated ledger as a closed episode", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 4, seen: {}, settled: "escalated" }),
			assistant("a1", "done"),
		);
		const scan = scanEntries(branch);
		expect(scan.ledger).toMatchObject({ v: 2, round: 4, settled: "cancelled" });
		expect(decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "done" }, review: review() })).toMatchObject({
			kind: "ignore",
			reason: "settled",
		});
	});

	it("counts unanswered advisor notes as findings alongside the reviewer", () => {
		const branch = entries(
			user("u1"),
			advisorNote("n0", [{ note: "already seen", severity: "concern" }]),
			assistant("a1", "done"),
			advisorNote("n1", [{ note: "missing test", severity: "blocker", advisor: "Arch" }]),
		);
		expect(pendingAdvisorFindings(branch)).toEqual([
			{ text: "missing test", severity: "blocker", advisor: "Arch" },
		]);

		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done" },
			review: review(),
		});
		expect(decision).toMatchObject({
			kind: "continue",
			round: 1,
			findings: [{ text: "missing test", severity: "blocker", advisor: "Arch" }],
		});
	});

	it("ignores advisor stop calls and excludes the advisor when configured", () => {
		const branch = entries(
			user("u1"),
			assistant("a1", "done"),
			advisorNote("n1", [{ note: "[converged] all findings closed" }]),
		);
		expect(pendingAdvisorFindings(branch)).toEqual([]);

		const withFinding = entries(
			user("u1"),
			assistant("a1", "done"),
			advisorNote("n1", [{ note: "missing test", severity: "concern" }]),
		);
		expect(
			decideAtStop({
				entries: withFinding,
				config: config({ includeAdvisor: false }),
				lastAssistant: { text: "done" },
				review: review(),
			}),
		).toMatchObject({ kind: "converged" });
	});

	it("merges duplicate findings from both sources at the higher severity", () => {
		const branch = entries(
			user("u1"),
			assistant("a1", "done"),
			advisorNote("n1", [{ note: "Missing test!", severity: "blocker" }]),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done" },
			review: notMet({ text: "missing test", severity: "nit" }),
		});
		expect(decision).toMatchObject({
			kind: "continue",
			findings: [{ text: "Missing test!", severity: "blocker" }],
		});
	});

	it("parses advisory XML when details are absent", () => {
		expect(
			parseAdvisorContent(
				'<advisory advisor="Arch" severity="concern">\nWrap &lt;stdout&gt; writes\n</advisory>\n<advisory>plain nit</advisory>',
			),
		).toEqual([
			{ text: "Wrap <stdout> writes", severity: "concern", advisor: "Arch" },
			{ text: "plain nit", severity: "nit" },
		]);
	});

	it("reopens a converged episode for a late advisor note", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {}, settled: "converged" }),
			assistant("a2", "done"),
			advisorNote("n2", [{ note: "late gap", severity: "concern" }]),
		);
		expect(
			decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "done" }, review: review() }),
		).toMatchObject({ kind: "ignore", reason: "settled" });
		expect(
			decideAtStop({
				entries: branch,
				config: config(),
				lastAssistant: { text: "done" },
				review: review(),
				allowReopen: true,
			}),
		).toMatchObject({ kind: "continue", round: 3, ledger: { anchor: "u1" } });
	});

	it("anchors on the last user message", () => {
		const branch = entries(
			user("u1"),
			assistant("a1", "first"),
			user("u2", "second request"),
			assistant("a2", "done"),
			ledger("l1", { v: 2, anchor: "u1", round: 5, seen: {} }),
		);
		expect(lastUserText(branch)).toBe("second request");
		expect(
			decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "done" }, review: notMet({ text: "gap" }) }),
		).toMatchObject({ kind: "continue", round: 1, ledger: { anchor: "u2" } });
	});
});

describe("prompts and notices", () => {
	it("asks the reviewer for a machine-readable verdict against the goal", () => {
		const prompt = buildReviewerPrompt("add a regression test");
		expect(prompt).toContain("<goal>\nadd a regression test\n</goal>");
		expect(prompt).toContain("goal_met");
		expect(prompt).toContain("<review>");
		expect(buildReviewerPrompt(undefined, { strict: true })).toContain("could not be parsed");
	});

	it("carries the findings, the report protocol, and no self-certification", () => {
		const prompt = buildRemediationPrompt([{ text: "missing test", severity: "concern" }], 2, 10);
		expect(prompt).toContain('<adversarial-review round="2" max_rounds="10">');
		expect(prompt).toContain("1. [concern] missing test");
		expect(prompt).toContain("1: fixed | rebutted | blocked");
		expect(prompt).not.toContain("verdict:");
		expect(prompt.toLowerCase()).not.toContain("escalat");
	});

	it("adds stall pressure and the over-budget note", () => {
		const prompt = buildRemediationPrompt([{ text: "missing test", severity: "concern" }], 11, 10, {
			tier: 2,
			repeated: [{ text: "missing test", severity: "concern" }],
			repeatedLimit: 3,
		});
		expect(prompt).toContain('<stall tier="2">');
		expect(prompt).toContain("Repetition is failure");
		expect(prompt).toContain("<budget>Round 11 exceeds the soft budget of 10");
	});

	it("reports convergence and manual verdicts plainly", () => {
		expect(buildConvergedNotice(0)).toContain("no continuation needed");
		expect(buildConvergedNotice(3)).toContain("met after 3 round(s)");
		expect(describeReview(notMet({ text: "gap", severity: "blocker" }, { text: "nit", severity: "nit" }))).toContain(
			"1. [blocker] gap\n2. [nit] nit",
		);
		expect(describeReview(review({ goal: "do the work" }))).toContain("goal met — do the work");
	});
});

describe("settings resolution", () => {
	it("clamps config values and ignores unknown severities", () => {
		expect(
			resolveConfig({ enabled: true, maxRounds: 500, maxRepeats: 0, minSeverity: "severe", notify: "yes" }),
		).toEqual({
			enabled: true,
			minSeverity: "nit",
			maxRounds: 100,
			maxRepeats: 1,
			includeAdvisor: true,
			forceSyncBacklog: true,
			useSessionModel: true,
			notify: true,
		});
	});

	it("applies environment overrides for one process", () => {
		expect(
			resolveEnvConfig({
				OMP_ADVISOR_CONSENSUS_ENABLED: "on",
				OMP_ADVISOR_CONSENSUS_MAX_ROUNDS: "7",
				OMP_ADVISOR_CONSENSUS_MAX_REPEATS: "2",
				OMP_ADVISOR_CONSENSUS_MIN_SEVERITY: "blocker",
				OMP_ADVISOR_CONSENSUS_NOTIFY: "off",
			}),
		).toEqual({ enabled: true, minSeverity: "blocker", maxRounds: 7, maxRepeats: 2, notify: false });
	});
});

describe("finding identity", () => {
	it("collapses punctuation and case so paraphrases still count", () => {
		expect(findingKey("  Missing  TEST!! ")).toBe("missing test");
	});
});
