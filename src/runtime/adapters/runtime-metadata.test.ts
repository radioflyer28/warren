import { expect, test } from "bun:test";
import { piAdapter } from "./pi.ts";
import { runtimeMetadataEvents } from "./runtime-metadata.ts";
import type { AdapterRuntimeEvent } from "./types.ts";

const context = { runId: "metadata", workspacePath: "/unused" };
const settled: AdapterRuntimeEvent = {
	kind: "state_change",
	stream: "system",
	payload: { type: "agent_settled", aborted: false },
};

test("session metadata precedes settlement and extraction never runs at agent_end", async () => {
	let calls = 0;
	const adapter = {
		...piAdapter,
		async extractMetadata() {
			calls++;
			return { session_id: "session-123" };
		},
	};
	const early = { ...settled, payload: { type: "agent_end", willRetry: true } };
	expect(await runtimeMetadataEvents(adapter, context, early)).toEqual([early]);
	expect(calls).toBe(0);
	expect(await runtimeMetadataEvents(adapter, context, settled)).toEqual([
		{
			kind: "state_change",
			stream: "system",
			payload: { type: "runtime_metadata", session_id: "session-123" },
		},
		settled,
	]);
	expect(calls).toBe(1);
});

test("missing metadata and failed reads do not suppress settlement", async () => {
	expect(
		await runtimeMetadataEvents(
			{ ...piAdapter, extractMetadata: async () => undefined },
			context,
			settled,
		),
	).toEqual([settled]);
	const result = await runtimeMetadataEvents(
		{
			...piAdapter,
			extractMetadata: async () => {
				throw new Error("private path");
			},
		},
		context,
		settled,
	);
	expect(result.at(-1)).toEqual(settled);
	expect(JSON.stringify(result)).not.toContain("private path");
});
