import type {
	AdapterExtractMetadataContext,
	AdapterRuntimeEvent,
	AgentRuntimeAdapter,
} from "./types.ts";

/** Emit metadata before the terminal carrier so the bridge persists it before reap. */
export async function runtimeMetadataEvents(
	runtime: AgentRuntimeAdapter,
	context: AdapterExtractMetadataContext,
	event: AdapterRuntimeEvent,
): Promise<AdapterRuntimeEvent[]> {
	if (!runtime.extractMetadata || !runtime.shouldCloseStdinOnEvent?.(event)) return [event];
	try {
		const metadata = await runtime.extractMetadata(context);
		if (!metadata) return [event];
		return [
			{
				kind: "state_change",
				stream: "system",
				payload: { type: "runtime_metadata", ...metadata },
			},
			event,
		];
	} catch {
		return [
			{
				kind: "telemetry",
				stream: "system",
				payload: {
					type: "runtime_metadata_error",
					message: "Could not read runtime session metadata",
				},
			},
			event,
		];
	}
}
