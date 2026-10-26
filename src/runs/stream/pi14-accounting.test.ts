import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parsePiEvents } from "../../runtime/adapters/parsers/pi.ts";
import { aggregateUsageFromEvents } from "../usage-aggregate.ts";
import { TurnMonitor, turnMonitorOptionsFromEnv } from "./turn-monitor.ts";
import type { StreamEventView } from "./types.ts";

const usage = (cost: number) => ({
	input: cost * 100,
	output: cost * 10,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { total: cost },
});
const event = (payload: object): StreamEventView => ({
	seq: 1,
	ts: new Date(0),
	kind: "state_change",
	stream: "system",
	payload,
});

test("Pi 1.4 streaming totals are replaced; retries and compaction count once", () => {
	const monitor = new TurnMonitor(turnMonitorOptionsFromEnv({}, 20));
	const events = [
		event({ type: "turn_start" }),
		event({ type: "message_update", usage: usage(1) }),
		event({ type: "message_update", usage: usage(2) }),
		event({ type: "message_end", message: { usage: usage(3) } }),
		event({ type: "turn_end", message: { stopReason: "error", usage: usage(3) } }),
		event({ type: "agent_end", willRetry: true }),
		event({ type: "compaction_end", result: { usage: usage(4) }, willRetry: true }),
		event({ type: "turn_start" }),
		event({ type: "message_update", usage: usage(1) }),
		event({ type: "turn_end", message: { stopReason: "stop", usage: usage(2) } }),
		event({ type: "agent_end" }),
		event({ type: "agent_settled", aborted: false }),
	];
	const costs = events.map((value) => {
		monitor.observe(value);
		return monitor.cumulativeCostUsd();
	});
	expect(costs).toEqual([null, 1, 2, 2, 3, 3, 7, 7, 8, 9, 9, 9]);
	expect(aggregateUsageFromEvents(events)).toMatchObject({
		costUsd: 9,
		tokensInput: 900,
		tokensOutput: 90,
	});
});

test("missing usage differs from zero and untrusted events cannot alter spend", () => {
	const monitor = new TurnMonitor(turnMonitorOptionsFromEnv({}, 1));
	const absent = event({ type: "turn_end", message: {} });
	monitor.observe(absent);
	expect(monitor.cumulativeCostUsd()).toBeNull();
	expect(aggregateUsageFromEvents([absent])).toBeNull();
	monitor.observe({ ...event({ type: "message_update", usage: usage(9) }), origin: "agent" });
	expect(monitor.cumulativeCostUsd()).toBeNull();
	const zero = event({ type: "turn_end", message: { usage: usage(0) } });
	monitor.observe(zero);
	expect(monitor.cumulativeCostUsd()).toBe(0);
	expect(aggregateUsageFromEvents([zero])?.costUsd).toBe(0);
});

test("captured Pi 1.4 binary trace preserves tools, settlement, and authoritative usage", async () => {
	const raw = await readFile(
		new URL(
			"../../runtime/adapters/parsers/__golden__/pi-v1.4.0-controlled-tools.jsonl",
			import.meta.url,
		),
		"utf8",
	);
	const lines = raw.trim().split("\n");
	const events = lines.flatMap(parsePiEvents);
	expect(events.some((value) => value.kind === "tool_use")).toBe(true);
	expect(
		lines.map((line) => JSON.parse(line)).filter((value) => value.type === "agent_settled"),
	).toHaveLength(1);
	const stats = aggregateUsageFromEvents(events);
	expect(stats?.tokensInput).toBeGreaterThan(0);
	expect(stats?.costUsd).toBeGreaterThan(0);
});
