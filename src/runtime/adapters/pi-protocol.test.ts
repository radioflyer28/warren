import { expect, test } from "bun:test";
import { piAdapter } from "./pi.ts";
import { createPiEventParser } from "./pi-protocol.ts";
import { encodePiStdin } from "./pi-stdin.ts";
import { RuntimeCompletion } from "./runtime-completion.ts";

function parser() {
	const stdin = encodePiStdin("task", []);
	return createPiEventParser({ argv: ["pi"], stdin });
}
const response = (disposition: string) => ({
	type: "response",
	id: "warren:initial",
	command: "prompt",
	success: true,
	data: { disposition },
});

test("acknowledgements and repeated agent_end never close stdin; settlement does", () => {
	const parse = parser();
	for (const payload of [
		response("started"),
		{ type: "agent_start" },
		{ type: "agent_end", willRetry: true },
		{ type: "auto_retry_start" },
		{ type: "agent_end", willRetry: false },
	]) {
		expect(
			parse(JSON.stringify(payload)).some((event) => piAdapter.shouldCloseStdinOnEvent?.(event)),
		).toBe(false);
	}
	const event = parse('{"type":"agent_settled","aborted":false}')[0];
	expect(event && piAdapter.shouldCloseStdinOnEvent?.(event)).toBe(true);
});

test("initial rejection is correlated and terminates promptly", () => {
	const parse = parser();
	const unrelated = {
		type: "response",
		id: "other",
		command: "prompt",
		success: false,
		error: "bad",
	};
	expect(parse(JSON.stringify(unrelated))).toHaveLength(1);
	const result = parse(JSON.stringify({ ...unrelated, id: "warren:initial" }));
	expect(result.at(-1)?.payload).toMatchObject({
		type: "agent_settled",
		stopReason: "error",
		reason: "prompt_rejected",
	});
});

test("handled input queries idle state before completing without a run", () => {
	const parse = parser();
	const events = parse(JSON.stringify(response("handled")));
	const probe = events.at(-1);
	if (!probe) throw new Error("Expected an idle-state probe");
	const command = JSON.parse(piAdapter.autoRespondToEvent?.(probe)?.stdin ?? "{}");
	expect(command.type).toBe("get_state");
	expect(
		parse(
			JSON.stringify({
				type: "response",
				command: "get_state",
				id: "other",
				success: true,
				data: {},
			}),
		),
	).toHaveLength(1);
	const result = parse(
		JSON.stringify({
			type: "response",
			command: "get_state",
			id: command.id,
			success: true,
			data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
		}),
	);
	expect(result.at(-1)?.payload).toMatchObject({
		type: "agent_settled",
		reason: "prompt_handled_without_run",
	});
});

test("queued startup steering is correlated before settlement", () => {
	const stdin = encodePiStdin("task", [{ body: "steer", priority: "normal" }]);
	const commands = stdin
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(commands.every((command) => command.streamingBehavior === "steer")).toBe(true);
	const parse = createPiEventParser({ argv: ["pi"], stdin });
	parse(JSON.stringify(response("started")));
	const early = parse('{"type":"agent_settled","aborted":false}');
	expect(early.some((event) => piAdapter.shouldCloseStdinOnEvent?.(event))).toBe(false);
	const final = parse(JSON.stringify({ ...response("queued"), id: commands[1].id }));
	expect(final.at(-1)?.payload).toMatchObject({ type: "agent_settled" });
});

test("provider error recovery, cancellation and unexpected zero exit", () => {
	const completion = new RuntimeCompletion("pi");
	const feed = (payload: unknown) =>
		completion.observe({ kind: "state_change", stream: "system", payload });
	expect(completion.failure(0)).toContain("before agent_settled");
	feed({ type: "turn_end", message: { stopReason: "error", errorMessage: "transient" } });
	expect(completion.failure(0)).toBe("transient");
	feed({ type: "turn_end", message: { stopReason: "stop" } });
	feed({ type: "agent_end" });
	expect(completion.failure(0)).toContain("before agent_settled");
	feed({ type: "agent_settled", aborted: true });
	expect(completion.failure(0)).toBeNull();
	expect(completion.cancelled).toBe(true);
});
