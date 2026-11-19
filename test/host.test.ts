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
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	let idle = true;

	const ctx = {
		agent: { kind: "main", id: "main", name: "main", depth: 0 },
		cwd: "/tmp/advisor-consensus-test",
		isIdle: () => idle,
		hasPendingMessages: () => false,
		setTimeout(callback: () => void) {
			queueMicrotask(callback);
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
		ctx,
		emit,
		appended,
		sent,
		setIdle(value: boolean) {
			idle = value;
		},
		notifications,
		statuses,
		commands,
	};
}

const stopEvent = { messages: [assistant("a9", "all done")], stop_hook_active: false, turn_id: 1, session_id: "s1" };

describe("host wiring", () => {
	it("turns an unanswered finding into one continuation carrying the ledger", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});
		await host.commands.get("adversarial")!.handler("on", host.ctx);

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeDefined();
		const continuation = result as { continue?: boolean; additionalContext?: string };
		expect(continuation.continue).toBe(true);
		expect(continuation.additionalContext).toContain('<advisor-consensus round="1" max_rounds="4">');
		expect(continuation.additionalContext).toContain("1. [concern] missing test");

		expect(host.appended).toHaveLength(1);
		expect(host.appended[0]).toEqual({
			type: "advisor-consensus",
			data: { v: 1, anchor: "u1", round: 1, seen: { "missing test": 1 } },
		});
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", "converge 1/4 · 1 open"]);
		expect(host.notifications.at(-1)?.message).toContain("round 1/4");
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
		expect(host.statuses.at(-1)).toEqual(["advisor-consensus", undefined]);
		expect(host.notifications.at(-1)?.message).toContain("converged after 1 round(s)");
	});

	it("stays inert until the user arms it", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.appended).toHaveLength(0);
		expect(host.notifications.at(-1)?.message).toContain("advisor-consensus: off");
	});

	it("stops acting while paused and picks the same round back up on resume", async () => {
		const branch = [user("u1"), assistant("a1", "done"), advisorNote("n1", "missing test", "concern")];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		const command = host.commands.get("adversarial")!;
		await command.handler("on", host.ctx);
		await command.handler("pause", host.ctx);
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
		await Promise.resolve();
		await Promise.resolve();

		expect(host.sent).toHaveLength(1);
		const injected = host.sent[0] as { message: { content: string; customType: string }; options: { triggerTurn: boolean } };
		expect(injected.message.customType).toBe("advisor-consensus");
		expect(injected.message.content).toContain("late nit: rename the helper");
		expect(injected.options.triggerTurn).toBe(true);
		expect(host.appended.at(-1)).toMatchObject({ data: { round: 2 } });
		expect(host.notifications.at(-1)?.message).toContain("late finding reopened round 2/4");
	});

	it("honors a per-session round budget set through /adversarial", async () => {
		const branch = [
			user("u1"),
			ledger("l1", { v: 1, anchor: "u1", round: 2, seen: {} }),
			assistant("a1", "done"),
			advisorNote("n1", "another problem", "nit"),
		];
		const host = createHost(branch);
		advisorConsensus(host.api);
		await host.emit("session_start", {});

		await host.commands.get("adversarial")!.handler("on", host.ctx);
		await host.commands.get("adversarial")!.handler("max 2", host.ctx);
		const result = await host.emit("session_stop", stopEvent);

		expect(result).toBeUndefined();
		expect(host.notifications.at(-1)?.level).toBe("warning");
		expect(host.notifications.at(-1)?.message).toContain("round budget exhausted after 2 round(s)");
		expect(host.appended.at(-1)).toMatchObject({ data: { settled: "escalated" } });
	});
});
