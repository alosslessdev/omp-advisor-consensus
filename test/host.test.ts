import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import advisorConsensus from "../extensions/consensus";

const TS = "2026-01-01T00:00:00.000Z";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

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

function advisorNote(id: string, note: string, severity?: string) {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TS,
		customType: "advisor",
		content: "",
		display: true,
		details: { notes: [{ note, ...(severity ? { severity } : {}) }] },
	};
}

function ledger(id: string, data: Record<string, unknown>) {
	return { type: "custom", id, parentId: null, timestamp: TS, customType: "advisor-consensus", data };
}

function metReply(): string {
	return '<review>{"goal_met": true, "goal": "do the work", "findings": []}</review>';
}

function unmetReply(text: string, severity = "concern"): string {
	return `<review>${JSON.stringify({ goal_met: false, findings: [{ severity, text }] })}</review>`;
}

/**
 * Minimal host double: records registrations and replays the events the
 * session emits. `runEphemeralTurn` is the plugin's reviewer, so the double
 * answers from a queued script instead of calling a model.
 */
function createHost(branch: unknown[], options: { reviewer?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const selectAnswers: string[] = [];
	const inputAnswers: string[] = [];
	const reviewPrompts: string[] = [];
	const reviewReplies: string[] = [];
	const timers = new Map<number, () => unknown>();
	let timerSeq = 0;
	let idle = true;

	const reviewer = {
		async runEphemeralTurn(reviewOptions: { promptText: string }) {
			reviewPrompts.push(reviewOptions.promptText);
			const reply = reviewReplies.shift();
			if (reply === undefined) throw new Error("no reviewer reply queued");
			return { replyText: reply, assistantMessage: {} };
		},
	};

	const ctx = {
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		cwd: "/tmp/advisor-consensus-test",
		mode: "print",
		isIdle: () => idle,
		hasPendingMessages: () => false,
		setTimeout(callback: () => unknown) {
			const id = ++timerSeq;
			timers.set(id, callback);
			return id;
		},
		setInterval() {
			return 0;
		},
		clearTimer(handle: unknown) {
			timers.delete(handle as number);
		},
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push([key, text]);
			},
			async select() {
				return selectAnswers.shift();
			},
			async input() {
				return inputAnswers.shift();
			},
		},
		...(options.reviewer === false ? {} : reviewer),
	};

	const api = {
		logger: { debug() {} },
		setLabel() {},
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, definition: unknown) {
			commands.set(
				name,
				definition as { handler: (args: string, ctx: unknown) => Promise<void> },
			);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
		sendMessage(message: unknown, sendOptions: unknown) {
			sent.push({ message, options: sendOptions });
		},
		pi: { settings: {} },
	};

	async function emit(name: string, event: Record<string, unknown>): Promise<unknown> {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx);
		return last;
	}

	return {
		api: api as unknown as ExtensionAPI,
		branch,
		ctx,
		emit,
		appended,
		sent,
		reviewPrompts,
		async runTimers() {
			const pending = [...timers.values()];
			timers.clear();
			await Promise.all(pending.map(callback => callback()));
		},
		setIdle(value: boolean) {
			idle = value;
		},
		queueSelect(...answers: string[]) {
			selectAnswers.push(...answers);
		},
		queueInput(...answers: string[]) {
			inputAnswers.push(...answers);
		},
		queueReview(...replies: string[]) {
			reviewReplies.push(...replies);
		},
		notifications,
		statuses,
		commands,
	};
}

const stopEvent = { messages: [], stop_hook_active: false, turn_id: 1, session_id: "s1" };

describe("host wiring", () => {
	it("stays inert until the user arms it", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		host.queueReview(metReply());

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(0);
		expect(host.appended).toHaveLength(0);
		expect(host.sent).toHaveLength(0);
		expect(host.notifications.at(-1)?.message).toContain("advisor-consensus: off");
	});

	it("spends round 1 as a host continuation carrying the reviewer's findings", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(unmetReply("missing test"));

		const result = (await host.emit("session_stop", stopEvent)) as {
			continue?: boolean;
			additionalContext?: string;
		};

		expect(host.reviewPrompts).toHaveLength(1);
		expect(host.reviewPrompts[0]).toContain("<goal>\ndo the work\n</goal>");
		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain('<adversarial-review round="1" max_rounds="100">');
		expect(result.additionalContext).toContain("1. [concern] missing test");
		expect(result.additionalContext).not.toContain("escalat");
		expect(host.sent).toHaveLength(0);

		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toEqual([
			{ type: "advisor-consensus", data: { v: 2, anchor: "u1", round: 1, seen: { "missing test": 1 } } },
		]);
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", "adversarial 1/100 · 1 open"]);
		expect(host.notifications.at(-1)?.message).toContain("round 1/100");
	});

	it("shows the live soft budget in the status line as soon as it is armed", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		await host.commands.get("adversarial")!.handler("on", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 100 rounds (soft) · repeats 3");

		await host.commands.get("adversarial")!.handler("max 12", host.ctx);
		await host.commands.get("adversarial")!.handler("repeats 5", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 12 rounds (soft) · repeats 5");
	});

	it("re-arms from the transcript after a resume", async () => {
		const branch = [
			user("u1"),
			{ type: "custom", id: "arm1", parentId: null, timestamp: TS, customType: "advisor-consensus-arm", data: { armed: true } },
			assistant("a1", "done"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		host.queueReview(unmetReply("missing test"));

		// No `/adversarial on` in this process: the branch says it was armed.
		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean };
		expect(result.continue).toBe(true);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial 1/100 · 1 open");
	});

	it("stays off after a resume when the transcript says it was turned off", async () => {
		const branch = [
			user("u1"),
			{ type: "custom", id: "arm1", parentId: null, timestamp: TS, customType: "advisor-consensus-arm", data: { armed: false } },
			assistant("a1", "done"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		host.queueReview(unmetReply("missing test"));

		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(0);
		expect(host.sent).toHaveLength(0);
	});

	it("converges when the reviewer accepts the goal", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 1, seen: { "missing test": 1 } }),
			assistant("a2", "added the test"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(metReply());

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.appended.at(-1)).toEqual({
			type: "advisor-consensus",
			data: { v: 2, anchor: "u1", round: 1, seen: { "missing test": 1 }, settled: "converged" },
		});
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", "adversarial converged · 1/100"]);
		expect(host.notifications.at(-1)?.message).toContain("met after 1 round(s)");
	});

	it("keeps re-prompting past the soft budget instead of escalating", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {} }),
			assistant("a1", "done"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("max 2", host.ctx);
		host.queueReview(unmetReply("another problem", "nit"));

		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean; additionalContext?: string };

		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain("<budget>Round 3 exceeds the soft budget of 2");
		expect(result.additionalContext).toContain("the loop does not hand off");
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 3 } });
		expect((host.appended.at(-1) as { data: Record<string, unknown> }).data.settled).toBeUndefined();
		expect(
			host.notifications.filter(entry => entry.message.includes("soft budget of 2 round(s) spent at round 3")),
		).toHaveLength(1);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial 3/2 · 1 open");
	});

	it("raises stall pressure when the reviewer repeats itself", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 3, seen: { "missing test": 3 }, stalls: 1 }),
			assistant("a1", "done"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(unmetReply("missing test"));

		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean; additionalContext?: string };

		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain('<stall tier="2">');
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 4, stalls: 2 } });
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial 4/100 · 1 open · stall 2");
		expect(host.notifications.some(entry => entry.message.includes("stall pressure 2"))).toBe(true);
	});

	it("does not continue when the reviewer reply never parses", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview("looks fine to me", "{still not json");

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(2);
		expect(host.reviewPrompts[1]).toContain("could not be parsed");
		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toHaveLength(0);
		expect(host.notifications.at(-1)?.level).toBe("warning");
		expect(host.notifications.at(-1)?.message).toContain("unusable");
	});

	it("does not continue when the reviewer turn itself fails", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(2);
		expect(host.notifications.at(-1)?.message).toContain("no reviewer reply queued");
	});

	it("does not review an interrupted turn", async () => {
		const branch = [user("u1"), assistant("a1", "stopped", "aborted")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(unmetReply("missing test"));

		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(0);
	});

	it("stops acting while paused and picks the same round back up on resume", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("pause", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial paused · 0/100");
		host.queueReview(unmetReply("missing test"));
		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.reviewPrompts).toHaveLength(0);
		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toHaveLength(0);

		await command.handler("resume", host.ctx);
		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean };
		expect(result.continue).toBe(true);
		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toHaveLength(1);
	});

	it("cancels an in-flight episode when turned off", async () => {
		const branch = [user("u1"), ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {} }), assistant("a1", "working")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("off", host.ctx);

		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toEqual([
			{
				type: "advisor-consensus",
				data: { v: 2, anchor: "u1", round: 2, seen: {}, settled: "cancelled" },
			},
		]);
		expect(host.appended.filter(entry => entry.type === "advisor-consensus-arm")).toEqual([
			{ type: "advisor-consensus-arm", data: { armed: true } },
			{ type: "advisor-consensus-arm", data: { armed: false } },
		]);
		expect(host.notifications.at(-1)?.message).toContain("cancelled mid-episode (round 2)");
		expect(host.statuses.at(-1)?.[1]).toBeUndefined();
		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
	});

	it("switches to steered rounds once the stop-hook budget is spent", async () => {
		const branch: unknown[] = [user("u1"), assistant("a1", "work")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		for (let round = 1; round <= 7; round++) {
			host.queueReview(unmetReply(`finding ${round}`));
			const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean } | undefined;
			if (round < 7) {
				expect(result?.continue).toBe(true);
			} else {
				// Round 7 is past the six host continuations this plugin spends, so it
				// is held until the loop actually ends and then steered in as a turn.
				expect(result).toBeUndefined();
				expect(host.sent).toHaveLength(0);
				await host.emit("agent_end", {});
				expect(host.sent).toHaveLength(1);
				const injected = host.sent[0] as { message: { content: string }; options: { triggerTurn: boolean } };
				expect(injected.message.content).toContain(`round="7"`);
				expect(injected.options.triggerTurn).toBe(true);
			}
			branch.push(assistant(`a${round + 10}`, `answer ${round}`));
			const appended = host.appended.filter(entry => entry.type === "advisor-consensus").at(-1);
			branch.push(ledger(`l${round}`, appended!.data as Record<string, unknown>));
		}

		expect(host.appended.at(-1)).toMatchObject({ data: { round: 7 } });
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial 7/100 · 1 open");
	});

	it("drives a round from an unanswered advisor finding even when the reviewer accepts", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(metReply());

		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean; additionalContext?: string };

		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain("1. [concern] missing test");
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 1, seen: { "missing test": 1 } } });
	});

	it("converges on an advisor stop call and ignores advisor notes when excluded", async () => {
		const branch = [
			user("u1"),
			assistant("a1", "done"),
			advisorNote("n1", "[converged] every finding is closed"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(metReply());

		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.appended.at(-1)).toMatchObject({ data: { settled: "converged" } });

		const excluded = createHost([user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")]);
		advisorConsensus(excluded.api);
		await excluded.emit("session_start", {});
		await excluded.commands.get("adversarial")!.handler("on", excluded.ctx);
		await excluded.commands.get("adversarial")!.handler("advisor off", excluded.ctx);
		excluded.queueReview(metReply());

		expect(await excluded.emit("session_stop", stopEvent)).toBeUndefined();
		expect(excluded.appended.at(-1)).toMatchObject({ data: { settled: "converged" } });
		expect(excluded.notifications.some(entry => entry.message.includes("advisor notes ignored"))).toBe(true);
	});

	it("reopens a converged episode for a late advisor note", async () => {
		const branch: unknown[] = [
			user("u1"),
			ledger("l1", { v: 2, anchor: "u1", round: 2, seen: {}, settled: "converged" }),
			assistant("a2", "done"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		await host.emit("agent_start", {});
		await host.emit("agent_end", {});

		branch.push(advisorNote("n2", "late gap", "concern"));
		host.queueReview(unmetReply("late gap"));
		await host.emit("message_end", {
			message: { role: "custom", customType: "advisor", content: "", details: { notes: [{ note: "late gap" }] } },
		});
		await host.runTimers();

		expect(host.sent).toHaveLength(1);
		const injected = host.sent[0] as { message: { content: string }; options: { triggerTurn: boolean } };
		expect(injected.message.content).toContain("late gap");
		expect(injected.options.triggerTurn).toBe(true);
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 3 } });
		expect(host.notifications.map(entry => entry.message).join("\n")).toContain("late advisor finding reopened round 3/100");
	});

	it("answers /adversarial review with a verdict and spends a round when armed", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.queueReview(unmetReply("missing verification", "blocker"));

		await host.commands.get("adversarial")!.handler("review", host.ctx);

		expect(host.notifications.some(entry => entry.message.includes("goal NOT met"))).toBe(true);
		expect(host.notifications.some(entry => entry.message.includes("[blocker] missing verification"))).toBe(true);
		expect(host.sent).toHaveLength(1);
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 1 } });
	});

	it("reports a missing reviewer API instead of looking broken", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")], { reviewer: false });
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.notifications.some(entry => entry.message.includes("does not expose ctx.runEphemeralTurn"))).toBe(true);
		expect(host.appended.filter(entry => entry.type === "advisor-consensus")).toHaveLength(0);
	});

	it("edits the live soft budget from the TUI editor", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.ctx.mode = "tui";
		host.queueSelect("Soft max rounds: 100", "Done");
		host.queueInput("7");

		await host.commands.get("adversarial")!.handler("config", host.ctx);

		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 7 rounds (soft) · repeats 3");
	});
});
