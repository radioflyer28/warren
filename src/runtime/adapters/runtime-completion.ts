import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter, SpawnCommand } from "./types.ts";

export function runtimeEventParser(runtime: AgentRuntimeAdapter, command: SpawnCommand) {
	return runtime.createEventParser?.(command) ?? runtime.parseEvents;
}

/** Completion state belongs to a single spawned process, including all retry attempts. */
export class RuntimeCompletion {
	sawTerminal = false;
	cancelled = false;
	#error: string | null = null;

	constructor(private readonly runtimeId: string) {}

	observe(event: AdapterRuntimeEvent): void {
		const env = extractAgentEventEnvelope(event);
		if (!env) return;
		if (this.runtimeId === "pi" && ["turn_end", "agent_end", "agent_settled"].includes(env.type)) {
			if (env.stopReason === "error")
				this.#error =
					typeof env.errorMessage === "string" && env.errorMessage
						? env.errorMessage
						: "Pi provider request failed";
			else if (env.stopReason !== undefined) this.#error = null;
		}
		if (env.type === "result") {
			this.sawTerminal = true;
			if (env.payload.is_error === true) this.#error = "Agent reported an error";
		}
		if (env.type === "agent_settled") {
			this.sawTerminal = true;
			this.cancelled = env.payload.aborted === true;
		}
	}

	effectiveExitCode(exitCode: number, streamError?: unknown): number {
		return this.failure(exitCode) !== null || streamError !== undefined || this.cancelled
			? exitCode || 1
			: exitCode;
	}

	failure(exitCode: number): string | null {
		if (this.#error) return this.#error;
		if (this.runtimeId === "pi" && !this.sawTerminal) {
			return `Pi exited ${exitCode} before agent_settled`;
		}
		return exitCode === 0 ? null : `agent exited with code ${exitCode}`;
	}
}
