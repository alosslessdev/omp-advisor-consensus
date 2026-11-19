import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	assistantText,
	buildConvergedNotice,
	buildEscalationNotice,
	buildRemediationPrompt,
	decideAtStop,
	DEFAULT_CONFIG,
	findingKey,
	findingsFromEntry,
	LEDGER_TYPE,
	parseAdvisorContent,
	parseVerdict,
	pendingFindings,
	resolveConfig,
	scanEntries,
	type ConsensusConfig,
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

function noteWithDetails(id: string, notes: Array<{ note: string; severity?: string; advisor?: string }>) {
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

function noteWithContent(id: string, content: string) {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TS,
		customType: "advisor",
		content,
		display: true,
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

describe("transcript scan", () => {
	it("treats only notes after the last assistant message as unanswered", () => {
		const branch = entries(
			user("u1"),
			noteWithDetails("a1", [{ note: "steered mid-run" }]),
			assistant("a2", "did the work"),
			noteWithDetails("a3", [{ note: "raised at the boundary" }]),
		);
		expect(pendingFindings(branch).map(finding => finding.text)).toEqual(["raised at the boundary"]);
	});

	it("anchors on the last user message and keeps the ledger", () => {
		const branch = entries(
			user("u1"),
			assistant("a1", "done"),
			ledger("l1", { v: 1, anchor: "u1", round: 2, seen: { stop: 1 } }),
		);
		const scan = scanEntries(branch);
		expect(scan.lastUserEntryId).toBe("u1");
		expect(scan.lastAssistant).toBe(1);
		expect(scan.ledger?.round).toBe(2);
		expect(scan.ledger?.seen).toEqual({ stop: 1 });
	});

	it("reads advisor details first and falls back to the advisory XML", () => {
		const fromDetails = findingsFromEntry(
			entries(noteWithDetails("a1", [{ note: " use the queue ", severity: "blocker", advisor: "Arch" }]))[0]!,
		);
		expect(fromDetails).toEqual([{ text: "use the queue", severity: "blocker", advisor: "Arch" }]);

		const fromXml = parseAdvisorContent(
			'<advisory advisor="Arch" severity="concern">\nWrap &lt;stdout&gt; writes\n</advisory>\n<advisory>plain nit</advisory>',
		);
		expect(fromXml).toEqual([
			{ text: "Wrap <stdout> writes", severity: "concern", advisor: "Arch" },
			{ text: "plain nit", severity: "nit" },
		]);
	});

	it("extracts the final answer text from assistant blocks", () => {
		expect(assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe(
			"a\nb",
		);
		expect(assistantText({ role: "assistant", content: [] })).toBe("");
	});
});

describe("settle decisions", () => {
	it("opens round 1 on the first unanswered finding", () => {
		const branch = entries(user("u1"), assistant("a1", "done"), noteWithDetails("n1", [{ note: "missing test" }]));
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "done", stopReason: "stop" },
		});

		expect(decision.kind).toBe("continue");
		if (decision.kind !== "continue") return;
		expect(decision.round).toBe(1);
		expect(decision.findings[0]?.text).toBe("missing test");
		expect(decision.ledger).toEqual({ anchor: "u1", round: 1, seen: { "missing test": 1 } });
	});

	it("ignores findings below the configured severity floor", () => {
		const branch = entries(user("u1"), assistant("a1", "done"), noteWithDetails("n1", [{ note: "typo in helper" }]));
		const decision = decideAtStop({
			entries: branch,
			config: config({ minSeverity: "concern" }),
			lastAssistant: { text: "done" },
		});
		expect(decision).toEqual({ kind: "ignore", reason: "no-findings", round: 0 });
	});

	it("declares convergence when the advisor stays silent after a round", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 } }),
			noteWithDetails("n1", [{ note: "missing test" }]),
			assistant("a1", "added the test\n<convergence>\n1: fixed — test added\nverdict: closed\n</convergence>"),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "added the test" },
		});
		expect(decision.kind).toBe("converged");
		if (decision.kind !== "converged") return;
		expect(decision.round).toBe(1);
		expect(decision.ledger.settled).toBe("converged");
	});

	it("does not call it convergence when the agent admits open work", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: {} }),
			assistant("a1", "<convergence>\nverdict: open\n</convergence>"),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "<convergence>\nverdict: open\n</convergence>" },
		});
		expect(decision.kind).toBe("escalate");
		if (decision.kind !== "escalate") return;
		expect(decision.reason).toBe("agent-open");
		expect(decision.ledger.settled).toBe("escalated");
	});

	it("closes the loop when the advisor calls stop through advise", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 } }),
			assistant("a1", "<convergence>\nverdict: open\n</convergence>"),
			noteWithDetails("n1", [{ note: "[converged] every finding is fixed or rebutted" }]),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config(),
			lastAssistant: { text: "<convergence>\nverdict: open\n</convergence>" },
		});
		expect(decision.kind).toBe("converged");
		if (decision.kind !== "converged") return;
		expect(decision.viaStopCall).toBe(true);
		expect(buildConvergedNotice(decision.round, decision.viaStopCall)).toContain("advisor called stop");
	});

	it("ignores a stop call that arrives alongside an open finding", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: {} }),
			assistant("a1", "done"),
			noteWithDetails("n1", [{ note: "[converged] looks fine" }, { note: "but the test is missing" }]),
		);
		const decision = decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "done" } });
		expect(decision.kind).toBe("continue");
		if (decision.kind !== "continue") return;
		expect(decision.findings.map(finding => finding.text)).toEqual(["but the test is missing"]);
	});

	it("escalates when the advisor re-raises the same finding past maxRepeats", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 2, seen: { "missing test": 2 } }),
			assistant("a1", "done twice"),
			noteWithDetails("n1", [{ note: "Missing test." }]),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config({ maxRepeats: 2 }),
			lastAssistant: { text: "done twice" },
		});
		expect(decision.kind).toBe("escalate");
		if (decision.kind !== "escalate") return;
		expect(decision.reason).toBe("repeated");
	});

	it("escalates when the round budget is spent", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 2, seen: {} }),
			assistant("a1", "done"),
			noteWithDetails("n1", [{ note: "a brand new problem" }]),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config({ maxRounds: 2 }),
			lastAssistant: { text: "done" },
		});
		expect(decision.kind).toBe("escalate");
		if (decision.kind !== "escalate") return;
		expect(decision.reason).toBe("rounds-exhausted");
		expect(decision.findings.map(finding => finding.text)).toEqual(["a brand new problem"]);
	});

	it("never continues an errored or aborted turn", () => {
		const branch = entries(user("u1"), assistant("a1", "boom"), noteWithDetails("n1", [{ note: "still broken" }]));
		for (const stopReason of ["error", "aborted"]) {
			expect(
				decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "boom", stopReason } }),
			).toEqual({ kind: "ignore", reason: "error-turn", round: 0 });
		}
	});

	it("does not reopen a settled episode", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: {}, settled: "converged" }),
			assistant("a1", "done"),
			noteWithDetails("n1", [{ note: "late card" }]),
		);
		expect(decideAtStop({ entries: branch, config: config(), lastAssistant: { text: "done" } })).toEqual({
			kind: "ignore",
			reason: "settled",
			round: 1,
		});
	});

	it("starts a fresh episode when the user sends a new prompt", () => {
		const branch = entries(
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 3, seen: {} }),
			assistant("a1", "done"),
			user("u2", "next task"),
			assistant("a2", "did it"),
			noteWithDetails("n1", [{ note: "new finding" }]),
		);
		const decision = decideAtStop({
			entries: branch,
			config: config({ maxRounds: 4 }),
			lastAssistant: { text: "did it" },
		});
		expect(decision.kind).toBe("continue");
		if (decision.kind !== "continue") return;
		expect(decision.round).toBe(1);
		expect(decision.ledger.anchor).toBe("u2");
	});
});

describe("continuation protocol", () => {
	it("numbers every finding and demands per-item closure", () => {
		const prompt = buildRemediationPrompt(
			[
				{ text: "missing test", severity: "concern", advisor: "Arch" },
				{ text: "leaks a handle", severity: "blocker" },
			],
			1,
			4,
		);
		expect(prompt).toContain('<advisor-consensus round="1" max_rounds="4">');
		expect(prompt).toContain('1. [concern] advisor="Arch" missing test');
		expect(prompt).toContain("2. [blocker] leaks a handle");
		expect(prompt).toContain("2: fixed | rebutted | blocked");
		expect(prompt).toContain("verdict: closed | open");
		expect(prompt).not.toContain("This is the final round");
	});

	it("warns on the final round", () => {
		expect(buildRemediationPrompt([{ text: "x", severity: "nit" }], 4, 4)).toContain(
			"This is the final round (4 of 4)",
		);
	});

	it("reads the last verdict block only", () => {
		expect(parseVerdict("<convergence>\nverdict: open\n</convergence>\n...\n<convergence>\nverdict: closed\n</convergence>")).toBe(
			"closed",
		);
		expect(parseVerdict("no block here")).toBeUndefined();
	});

	it("summarizes escalations without dropping the findings", () => {
		const notice = buildEscalationNotice("repeated", [{ text: "  missing test  ", severity: "concern" }], 2);
		expect(notice).toContain("re-raised the same finding after 2 round(s)");
		expect(notice).toContain("1. [concern] missing test");
	});
});

describe("configuration", () => {
	it("normalizes identities the same way the advisor guard does", () => {
		expect(findingKey("Stop.")).toBe(findingKey("  *STOP*  "));
		expect(findingKey("Missing test.")).toBe("missing test");
	});

	it("clamps and validates plugin settings and env overrides", () => {
		const fromSettings = resolveConfig(
			{ maxRounds: "99", minSeverity: "BLOCKER", enabled: "no", forceSyncBacklog: "off", notify: "yes" },
			{},
		);
		expect(fromSettings).toMatchObject({
			maxRounds: 99,
			minSeverity: "blocker",
			enabled: false,
			forceSyncBacklog: false,
			notify: true,
		});

		const fromEnv = resolveConfig(
			{ maxRounds: 2, minSeverity: "concern" },
			{ OMP_ADVISOR_CONSENSUS_MAX_ROUNDS: "3", OMP_ADVISOR_CONSENSUS_MIN_SEVERITY: "nit" },
		);
		expect(fromEnv.maxRounds).toBe(3);
		expect(fromEnv.minSeverity).toBe("nit");

		expect(resolveConfig({ maxRounds: "abc", minSeverity: "nope" }, {})).toMatchObject({
			maxRounds: DEFAULT_CONFIG.maxRounds,
			minSeverity: DEFAULT_CONFIG.minSeverity,
		});
	});
});
