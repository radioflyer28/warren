/**
 * The pi-SDK adapter: builds the judge session factory over
 * `@earendil-works/pi-coding-agent`. Production integration; loop tests stub the
 * factory seam, while compatibility tests use the real SDK with a controlled provider.
 *
 * The session is created with `noTools: "builtin"` (the built-in coding
 * toolset — read/bash/edit/write — stripped) and exactly the three custom
 * tools from `judge-tools.ts`. The model resolves via {@link ModelRuntime}
 * from `JUDGE_PROVIDER`/`JUDGE_MODEL`; the runtime resolves the credential
 * from the per-provider environment keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, …), so no vendor is hardcoded (agent-analytics §12.5:
 * the operator's own key, always).
 *
 * The resource loader is hermetic by construction: the judge's system
 * prompt is the rubric prompt and nothing else — no project AGENTS.md, no
 * skills, no `.pi` extensions from whatever cwd the process has.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { prepareJudgeAuth } from "./pi-auth.ts";
import type { JudgeSession, JudgeSessionFactory, SessionStatsSnapshot } from "./judge-loop.ts";
import type { JudgeToolSpec } from "./judge-tools.ts";

export class JudgeSessionError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "JudgeSessionError";
	}
}

/** Widen a judge tool spec into a pi ToolDefinition. */
function toToolDefinition(spec: JudgeToolSpec): ToolDefinition {
	// FRICTION: pi pins the `typebox` package while this extension builds
	// schemas with `@sinclair/typebox`; the runtime objects are identical
	// JSON-schema structures, so the cast is structure-only.
	const parameters = spec.parameters as ToolDefinition["parameters"];
	return {
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters,
		...(spec.promptGuidelines !== undefined
			? { promptGuidelines: [...spec.promptGuidelines] }
			: {}),
		execute: async (toolCallId, params, signal) => {
			const result = await spec.execute(toolCallId, params, signal);
			return {
				...result,
				details: result.details ?? null,
				content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
			};
		},
	};
}

/**
 * A hermetic resource loader: the rubric system prompt, no extensions, no
 * skills, no project context files. A default loader would pull the cwd's
 * AGENTS.md and `.pi` content into the judge's context, which is exactly
 * the contamination (and Goodhart door, §12.5) the judge prompt forbids.
 */
class JudgeResourceLoader implements ResourceLoader {
	readonly #systemPrompt: string;
	public constructor(systemPrompt: string) {
		this.#systemPrompt = systemPrompt;
	}
	public getExtensions() {
		// No extensions load, but the runtime object must be REAL:
		// AgentSession hands it to ExtensionRunner, whose bindCore assigns
		// action methods onto it unconditionally — `runtime: undefined`
		// throws `undefined is not an object (evaluating
		// 'this.runtime.sendMessage')` on the first prompt (warren-5fcf,
		// hit live: every judgment errored). Fresh per call so no state
		// leaks between judge sessions.
		return { extensions: [], runtime: createExtensionRuntime(), errors: [] };
	}
	public getSkills() {
		return { skills: [], diagnostics: [] };
	}
	public getPrompts() {
		return { prompts: [], diagnostics: [] };
	}
	public getThemes() {
		return { themes: [], diagnostics: [] };
	}
	public getAgentsFiles() {
		return { agentsFiles: [] };
	}
	public getSystemPrompt(): string {
		return this.#systemPrompt;
	}
	public getSystemPromptSource(): undefined {
		return undefined;
	}
	public getAppendSystemPrompt(): string[] {
		return [];
	}
	public getAppendSystemPromptSources(): [] {
		return [];
	}
	public extendResources(): void {}
	public async reload(): Promise<void> {}
}

/** One pi-session judge attempt, satisfying the loop's session seam. */
class PiJudgeSession implements JudgeSession {
	/** Captured via closure in the factory. */
	public constructor(
		private readonly session: {
			prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>;
			waitForIdle(): Promise<void>;
			getSessionStats(): {
				tokens: {
					input: number;
					output: number;
					cacheRead: number;
					cacheWrite: number;
					total: number;
				};
				cost: number;
			};
			readonly state: { readonly errorMessage?: string };
			dispose(): void;
		},
		private readonly cleanup: () => void,
	) {}

	public async prompt(text: string): Promise<void> {
		// expandPromptTemplates=false: the judge prompt is literal; a `:command`
		// style string must never resolve against a template directory.
		await this.session.prompt(text, { expandPromptTemplates: false });
	}

	public async waitForIdle(): Promise<void> {
		await this.session.waitForIdle();
	}

	public getSessionStats(): SessionStatsSnapshot {
		const stats = this.session.getSessionStats();
		return { tokens: { ...stats.tokens }, costUsd: stats.cost };
	}

	public getLastError(): string | null {
		// AgentState.errorMessage carries the text of the most recent failed or
		// aborted assistant turn. The stream contract says a request, model or
		// runtime failure must never throw: it lands here instead.
		return this.session.state.errorMessage ?? null;
	}

	public dispose(): void {
		try {
			this.session.dispose();
		} finally {
			this.cleanup();
		}
	}
}

export interface PiSessionFactoryOptions {
	readonly provider: string;
	readonly model: string;
	/** Judge sessions are stateless; a scratch cwd keeps session data off-disk. */
	readonly cwd?: string;
	/** Inject a pre-built runtime (tests/embedding); created per call otherwise. */
	readonly modelRuntime?: ModelRuntime;
	/** Trusted operator setting; never resolved from a judged repository. */
	readonly authFile?: string;
}

/**
 * Resolve the judge model from the runtime. Throws `JudgeSessionError` when
 * the provider/model pair is not available — a config mistake, surfacing in
 * the judgment as `judge_error` rather than as a mislabeled verdict.
 */
async function resolveModel(runtime: ModelRuntime, provider: string, model: string) {
	const resolved = runtime.getModel(provider, model);
	if (resolved === undefined) {
		const available = runtime
			.getModels(provider)
			.map((m) => m.id)
			.slice(0, 20);
		throw new JudgeSessionError(
			`no model ${provider}/${model} in the pi model runtime` +
				(available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
		);
	}
	return resolved;
}

/**
 * Build the production {@link JudgeSessionFactory}. Every invocation of the
 * returned factory creates a fresh pi session (one per judgment attempt) so
 * no transcript from a failed attempt leaks into a retry.
 */
export function createPiSessionFactory(opts: PiSessionFactoryOptions): JudgeSessionFactory {
	return async ({ systemPrompt, tools }) => {
		const auth = prepareJudgeAuth(opts.provider, opts.authFile);
		const cwd = opts.cwd ?? auth.directory;
		try {
			const runtime =
				opts.modelRuntime ??
				(await ModelRuntime.create({
					authPath: auth.authPath,
					modelsPath: null,
					modelsStorePath: join(auth.directory, "models"),
					allowModelNetwork: false,
				}));
			const model = await resolveModel(runtime, opts.provider, opts.model);
			const { session } = await createAgentSession({
				cwd,
				modelRuntime: runtime,
				model,
				noTools: "builtin",
				tools: tools.map((tool) => tool.name),
				excludeTools: ["mcp__*"],
				customTools: tools.map(toToolDefinition),
				resourceLoader: new JudgeResourceLoader(systemPrompt),
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory(),
			});
			return new PiJudgeSession(session, auth.cleanup);
		} catch (error) {
			auth.cleanup();
			throw error;
		}
	};
}
