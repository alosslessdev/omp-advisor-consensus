import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import advisorConsensus from "../extensions/consensus";

const TS = "2026-01-01T00:00:00.000Z";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function user(id: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content: [{ type: "text", text: "do the work" }] },
	};
}

function assistant(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
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

/**
 * Minimal host double: records registrations and replays the events the
 * session emits. The cast lands here, once, because the double implements only
 * the surfaces this plugin touches.
 */
function createHost(branch: unknown[]) {
	const handlers = new Map<string, Handler[]>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const selectAnswers: string[] = [];
	const inputAnswers: string[] = [];
	let idle = true;

	const ctx = {
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		cwd: "/tmp/advisor-consensus-test",
		mode: "print",
		isIdle: () => idle,
		hasPendingMessages: () => false,
		// Deterministic: the plugin schedules its catch-up through this context
		// timer, so running it inline keeps the test free of wall-clock waits.
		setTimeout(callback: () => void) {
			callback();
			return 1;
		},
		setInterval() {
			return 1;
		},
		clearTimer() {},
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
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
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
		setIdle(value: boolean) {
			idle = value;
		},
		queueSelect(...answers: string[]) {
			selectAnswers.push(...answers);
		},
		queueInput(...answers: string[]) {
			inputAnswers.push(...answers);
		},
		notifications,
		statuses,
		commands,
	};
}

const stopEvent = { messages: [assistant("a9", "all done")], stop_hook_active: false, turn_id: 1, session_id: "s1" };

describe("host wiring", () => {
	it("stays inert until the user arms it", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.appended).toHaveLength(0);
		expect(host.sent).toHaveLength(0);
		expect(host.notifications.at(-1)?.message).toContain("advisor-consensus: off");
	});

	it("spends round 1 as a host continuation carrying the ledger", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		const result = (await host.emit("session_stop", stopEvent)) as {
			continue?: boolean;
			additionalContext?: string;
		};

		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain('<advisor-consensus round="1" max_rounds="100">');
		expect(result.additionalContext).toContain("1. [concern] missing test");
		expect(host.sent).toHaveLength(0);

		expect(host.appended).toEqual([
			{ type: "advisor-consensus", data: { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 } } },
		]);
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", "adversarial 1/100 · 1 open"]);
		expect(host.notifications.at(-1)?.message).toContain("round 1/100");
	});

	it("shows the live budget in the status line as soon as it is armed", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		await host.commands.get("adversarial")!.handler("on", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 100 rounds · repeats 3");

		await host.commands.get("adversarial")!.handler("max 12", host.ctx);
		await host.commands.get("adversarial")!.handler("repeats 5", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 12 rounds · repeats 5");
	});

	it("settles once the advisor is silent and records the converged episode", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 } }),
			advisorNote("n1", "missing test", "concern"),
			assistant("a2", "added the test"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		const result = await host.emit("session_stop", {
			messages: [assistant("a2", "added the test")],
			stop_hook_active: true,
			turn_id: 2,
			session_id: "s1",
		});

		expect(result).toBeUndefined();
		expect(host.appended.at(-1)).toEqual({
			type: "advisor-consensus",
			data: { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 }, settled: "converged" },
		});
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", "adversarial converged · 1/100"]);
		expect(host.notifications.at(-1)?.message).toContain("converged after 1 round(s)");
	});

	it("stops acting while paused and picks the same round back up on resume", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("pause", host.ctx);
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial paused · 0/100");
		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
		expect(host.appended).toHaveLength(0);

		await command.handler("resume", host.ctx);
		const result = (await host.emit("session_stop", stopEvent)) as { continue?: boolean };
		expect(result.continue).toBe(true);
		expect(host.appended).toHaveLength(1);
	});

	it("cancels an in-flight episode when turned off", async () => {
		const branch = [user("u1"), ledger("l1", { v: 1, anchor: "u1", round: 2, seen: {} }), assistant("a1", "working")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("off", host.ctx);

		expect(host.appended).toEqual([
			{
				type: "advisor-consensus",
				data: { v: 1, anchor: "u1", round: 2, seen: {}, settled: "cancelled" },
			},
		]);
		expect(host.notifications.at(-1)?.message).toContain("cancelled mid-episode (round 2)");
		expect(host.statuses.at(-1)?.[1]).toBeUndefined();
		expect(await host.emit("session_stop", stopEvent)).toBeUndefined();
	});

	it("reopens a converged episode when the advisor raises a late note", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 }, settled: "converged" }),
			assistant("a2", "added the test\n<convergence>\nverdict: closed\n</convergence>"),
			advisorNote("n3", "late nit: rename the helper", "nit"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		await host.emit("agent_start", {});
		await host.emit("agent_end", {});
		await host.emit("message_end", {
			message: { role: "custom", customType: "advisor", content: "", details: { notes: [{ note: "x" }] } },
		});
		expect(host.sent).toHaveLength(1);
		const injected = host.sent[0] as {
			message: { content: string; customType: string; display: boolean };
			options: { triggerTurn: boolean };
		};
		expect(injected.message.customType).toBe("advisor-consensus");
		expect(injected.message.display).toBe(false);
		expect(injected.message.content).toContain("late nit: rename the helper");
		expect(injected.options.triggerTurn).toBe(true);
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 2 } });
		expect(host.notifications.map(entry => entry.message).join("\n")).toContain(
			"late finding reopened round 2/100",
		);
	});

	it("switches from host continuations to steered rounds once the stop-hook budget is spent", async () => {
		const branch: unknown[] = [user("u1"), assistant("a1", "work")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		for (let round = 1; round <= 7; round++) {
			branch.push(advisorNote(`n${round}`, `finding ${round}`, "concern"));
			const result = await host.emit("session_stop", stopEvent);
			if (round < 7) {
				expect(result).toBeDefined();
			} else {
				// Round 7 is past the six host continuations this plugin spends, so it
				// is held until the loop actually ends and then steered in as a turn.
				expect(result).toBeUndefined();
				expect(host.sent).toHaveLength(0);
				await host.emit("agent_end", {});
				expect(host.sent).toHaveLength(1);
				const injected = host.sent[0] as { options: { triggerTurn: boolean } };
				expect(injected.options.triggerTurn).toBe(true);
			}
			branch.push(assistant(`a${round + 10}`, `answer ${round}`));
			branch.push(ledger(`l${round}`, { v: 1, anchor: "u1", round, seen: {} }));
		}

		expect(host.appended.at(-1)).toMatchObject({ data: { round: 7 } });
		expect(host.statuses.at(-1)?.[1]).toBe("adversarial 7/100 · 1 open");
	});

	it("honors a per-session round budget", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 2, seen: {} }),
			assistant("a1", "done"),
			advisorNote("n1", "another problem", "nit"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("max 2", host.ctx);
		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.notifications.at(-1)?.level).toBe("warning");
		expect(host.notifications.at(-1)?.message).toContain("round budget exhausted after 2 round(s)");
		expect(host.appended.at(-1)).toMatchObject({ data: { settled: "escalated" } });
	});

	it("edits the live budget from the TUI editor", async () => {
		const host = createHost([user("u1"), assistant("a1", "done")]);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);
		host.ctx.mode = "tui";
		host.queueSelect("Max rounds: 100", "Done");
		host.queueInput("7");

		await host.commands.get("adversarial")!.handler("config", host.ctx);

		expect(host.statuses.at(-1)?.[1]).toBe("adversarial on · 7 rounds · repeats 3");
	});
});
