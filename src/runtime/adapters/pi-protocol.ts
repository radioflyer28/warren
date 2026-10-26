/**
 * Pi 1.4 RPC state allocated for one process. Raw envelopes remain observable;
 * rejected or consumed prompts have explicit, correlated completion paths.
 */
import { randomUUID } from "node:crypto";
import { type AgentEventEnvelope, extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import { parsePiEvents } from "./parsers/pi.ts";
import type { AdapterRuntimeEvent, SpawnCommand } from "./types.ts";

export function createPiEventParser(
	command: SpawnCommand,
): (line: string) => AdapterRuntimeEvent[] {
	const protocol = new PiProtocol(command);
	return (line) => parsePiEvents(line).flatMap((event) => protocol.observe(event));
}

class PiProtocol {
	private readonly pending = new Set<string>();
	private started = false;
	private accepted = false;
	private settled = false;
	private probeId: string | undefined;
	private deferred: AdapterRuntimeEvent | undefined;

	constructor(command: SpawnCommand) {
		for (const line of command.stdin?.split("\n") ?? []) {
			if (!line.trim()) continue;
			const request = JSON.parse(line) as { id?: string; type?: string };
			if (request.type === "prompt" && request.id) this.pending.add(request.id);
		}
	}

	observe(event: AdapterRuntimeEvent): AdapterRuntimeEvent[] {
		const env = extractAgentEventEnvelope(event);
		if (env?.type === "agent_start") this.started = true;
		if (env?.type === "agent_settled") {
			if (this.pending.size > 0) {
				this.deferred = event;
				return [{ ...event, kind: "telemetry" }];
			}
			this.settled = true;
		}
		if (env?.type !== "response" || this.settled) return [event];
		return [event, ...this.response(env)];
	}

	private response(env: AgentEventEnvelope): AdapterRuntimeEvent[] {
		const payload = env.payload;
		const id = payload.id;
		if (this.probeId !== undefined && id === this.probeId && payload.command === "get_state") {
			this.probeId = undefined;
			return this.stateResponse(payload);
		}
		if (typeof id !== "string" || payload.command !== "prompt") return [];
		const startup = this.pending.delete(id);
		if (!startup && !id.startsWith("warren:prompt:")) return [];
		if (payload.success !== true) {
			const error = typeof payload.error === "string" ? payload.error : "Pi rejected a prompt";
			return [this.finish("prompt_rejected", error)];
		}
		const disposition = (payload.data as { disposition?: string } | undefined)?.disposition;
		if (disposition === "started" || disposition === "queued") this.accepted = true;
		else if (disposition !== "handled") {
			return [this.finish("invalid_prompt_response", "Pi returned an unknown prompt disposition")];
		}
		return startup && this.pending.size === 0 ? this.afterStartup() : [];
	}

	private stateResponse(payload: Record<string, unknown>): AdapterRuntimeEvent[] {
		const state = payload.data as Record<string, unknown> | undefined;
		if (payload.success !== true || !state) {
			return [this.finish("state_probe_rejected", "Pi rejected the idle-state query")];
		}
		if (
			(!this.started || this.deferred !== undefined) &&
			state.isStreaming === false &&
			state.isCompacting === false &&
			state.pendingMessageCount === 0
		) {
			if (this.deferred) {
				this.settled = true;
				return [this.deferred];
			}
			return [this.finish("prompt_handled_without_run")];
		}
		this.deferred = undefined;
		return [];
	}

	private afterStartup(): AdapterRuntimeEvent[] {
		// A delayed prompt can start another run after the saved settlement.
		// Confirm idle state after every startup acknowledgement before replaying it.
		if (!this.deferred && (this.accepted || this.started)) return [];
		this.probeId = `warren:state:${randomUUID()}`;
		return [
			{
				kind: "state_change",
				stream: "system",
				payload: { type: "pi_rpc_probe", id: this.probeId },
			},
		];
	}

	private finish(reason: string, errorMessage?: string): AdapterRuntimeEvent {
		this.settled = true;
		return {
			kind: "state_change",
			stream: "system",
			payload: {
				type: "agent_settled",
				aborted: false,
				synthesized: true,
				reason,
				...(errorMessage ? { stopReason: "error", errorMessage } : {}),
			},
		};
	}
}
