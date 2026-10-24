import { afterEach, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSessionFactory } from "./pi-session.ts";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function controlledFactory(fail = false) {
	const cwd = mkdtempSync(join(tmpdir(), "judge-sdk-"));
	roots.push(cwd);
	writeFileSync(join(cwd, "AGENTS.md"), "UNTRUSTED PROJECT PROMPT");
	const requests: {
		messages: { role: string; content: unknown }[];
		tools: { function: { name: string } }[];
	}[] = [];
	const names = ["get_run_facts", "page_events", "report_verdict"];
	const executed: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			requests.push((await request.json()) as (typeof requests)[number]);
			if (fail)
				return Response.json(
					{
						error: {
							message: "controlled authentication failure",
							type: "authentication_error",
						},
					},
					{ status: 401 },
				);
			const index = (requests.length - 1) % names.length;
			const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({
				id: "controlled",
				object: "chat.completion.chunk",
				created: 1,
				model: "controlled",
				choices: [{ index: 0, delta, finish_reason }],
				...(usage ? { usage } : {}),
			});
			const parts = [
				chunk(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call-${requests.length}`,
								type: "function",
								function: { name: names[index], arguments: "{}" },
							},
						],
					},
					null,
				),
				chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }),
			];
			return new Response(
				parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	servers.push(server);
	writeFileSync(join(cwd, "auth.json"), "{}");
	const runtime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		modelsStorePath: join(cwd, "catalog"),
	});
	runtime.registerProvider("warren-test", {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		api: "openai-completions",
		apiKey: "controlled-test-key",
		models: [
			{
				id: "controlled",
				name: "Controlled",
				reasoning: false,
				input: ["text"],
				contextWindow: 32000,
				maxTokens: 1024,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const factory = createPiSessionFactory({
		provider: "warren-test",
		model: "controlled",
		modelRuntime: runtime,
		cwd,
	});
	const tools = names.map((name) => ({
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			executed.push(name);
			return {
				content: [{ type: "text" as const, text: "ok" }],
				...(name === "report_verdict" ? { terminate: true } : {}),
			};
		},
	}));
	return { factory, requests, executed, names, tools };
}

test("Pi 1.4 SDK executes exactly the judge tools, settles, reports usage, and isolates attempts", async () => {
	const setup = await controlledFactory();
	for (let attempt = 0; attempt < 2; attempt++) {
		const session = await setup.factory({
			systemPrompt: "ONLY THE RUBRIC",
			tools: setup.tools,
		});
		try {
			await session.prompt("Judge this run");
			await session.waitForIdle();
			expect(session.getLastError()).toBeNull();
			expect(session.getSessionStats().tokens.input).toBe(30);
			expect(session.getSessionStats().tokens.output).toBe(9);
			expect(session.getSessionStats().costUsd).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	}
	expect(setup.executed).toEqual([...setup.names, ...setup.names]);
	for (const request of setup.requests) {
		expect(request.tools.map((tool) => tool.function.name).sort()).toEqual(
			[...setup.names].sort(),
		);
		expect(JSON.stringify(request.messages)).not.toContain("UNTRUSTED PROJECT PROMPT");
		expect(JSON.stringify(request.messages)).toContain("ONLY THE RUBRIC");
	}
	expect(setup.requests[0]?.messages).toEqual(setup.requests[3]?.messages);
}, 20000);

test("Pi SDK provider errors settle and remain observable", async () => {
	const setup = await controlledFactory(true);
	const session = await setup.factory({ systemPrompt: "rubric", tools: setup.tools });
	try {
		await session.prompt("Judge");
		await session.waitForIdle();
		expect(session.getLastError()).toContain("controlled authentication failure");
		expect(setup.executed).toEqual([]);
	} finally {
		session.dispose();
	}
}, 10000);
