import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piAdapter } from "./pi.ts";
import type { SpawnCommand } from "./types.ts";

const cli = process.env.WARREN_PI_TEST_CLI;
type WireEvent = Record<string, unknown>;

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Pi adapter hook is missing");
	return value;
}

function controlledProvider(root: string) {
	let calls = 0;
	return Bun.serve({
		port: 0,
		async fetch(request) {
			await request.json();
			calls++;
			const delta =
				calls === 1
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "read-fixture",
									type: "function",
									function: {
										name: "read",
										arguments: JSON.stringify({ path: join(root, "fixture.txt") }),
									},
								},
							],
						}
					: { role: "assistant", content: "fixture checked" };
			const chunk = (value: unknown, reason: string | null) => ({
				id: `response-${calls}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "controlled",
				choices: [{ index: 0, delta: value, finish_reason: reason }],
				usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
			});
			return new Response(
				`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, calls === 1 ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
}

async function configureProvider(agentDir: string, port: number) {
	await mkdir(agentDir);
	await writeFile(join(agentDir, "auth.json"), "{}");
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"warren-contract": {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "test-key",
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
				},
			},
		}),
	);
}

function launch(binary: string, command: SpawnCommand, root: string, agentDir: string) {
	return Bun.spawn(["node", binary, ...command.argv.slice(1)], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			HOME: root,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const bytes of stream) {
		buffer += decoder.decode(bytes, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			yield buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
}

async function collect(
	child: ReturnType<typeof launch>,
	command: SpawnCommand,
): Promise<WireEvent[]> {
	const events: WireEvent[] = [];
	const parse = required(piAdapter.createEventParser)(command);
	let steered = false;
	for await (const line of readLines(child.stdout)) {
		if (!line.trim()) continue;
		const raw = JSON.parse(line) as WireEvent;
		events.push(raw);
		if (raw.type === "tool_execution_start" && !steered) {
			const message = required(
				piAdapter.encodeSteeringMessage?.({
					body: "Confirm the fixture was checked",
					priority: "normal",
				}),
			);
			child.stdin.write(message.stdin);
			await child.stdin.flush();
			steered = true;
		}
		for (const event of parse(line)) {
			const reply = piAdapter.autoRespondToEvent?.(event);
			if (reply) {
				child.stdin.write(reply.stdin);
				await child.stdin.flush();
			}
			if (piAdapter.shouldCloseStdinOnEvent?.(event)) child.stdin.end();
		}
	}
	return events;
}

async function drive(binary: string, root: string, agentDir: string) {
	const context = {
		runId: "contract",
		prompt: "Read fixture.txt",
		pendingMessages: [],
		workspacePath: root,
		frontmatter: {
			provider: "warren-contract",
			model: "controlled",
			pi: { tools: "read", approve: true },
		},
	};
	await piAdapter.prepareWorkspace?.(context);
	const command = required(piAdapter.buildSpawnCommand?.(context));
	const child = launch(binary, command, root, agentDir);
	const deadline = setTimeout(() => child.kill(), 20000);
	const stderr = new Response(child.stderr).text();
	try {
		child.stdin.write(required(command.stdin));
		await child.stdin.flush();
		const events = await collect(child, command);
		expect(await child.exited, await stderr).toBe(0);
		return events;
	} finally {
		clearTimeout(deadline);
		child.kill();
		await child.exited;
	}
}

async function saveCapture(events: WireEvent[], root: string) {
	const destination = process.env.WARREN_PI_CAPTURE_DIR;
	if (!destination) return;
	const lines = events
		.map((event) =>
			JSON.stringify(event, (key, value: unknown) => {
				if (key === "timestamp" || key === "durationMs") return 0;
				if (typeof value !== "string") return value;
				return value
					.replaceAll(root, "<workspace>")
					.replace(/warren:prompt:[a-f0-9-]+/g, "warren:prompt:fixture");
			}),
		)
		.join("\n");
	await writeFile(join(destination, "pi-v1.4.0-controlled-tools.jsonl"), `${lines}\n`);
}

/** Opt-in binary contract test: no provider network or personal credentials. */
test.skipIf(!cli)(
	"Pi 1.4.0 binary performs a tool call, accepts steering and settles",
	async () => {
		if (!cli) return;
		const root = await mkdtemp(join(tmpdir(), "warren-pi-contract-"));
		const server = controlledProvider(root);
		try {
			const agentDir = join(root, "agent-home");
			await configureProvider(agentDir, required(server.port));
			await writeFile(join(root, "fixture.txt"), "fixture content");
			expect(Bun.spawnSync(["node", cli, "--version"]).stdout.toString().trim()).toBe("1.4.0");
			const events = await drive(cli, root, agentDir);
			expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
			expect(events.at(-1)?.type).toBe("agent_settled");
			expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
			expect(events.some((event) => event.type === "message_update" && event.usage)).toBe(true);
			expect(
				events.filter((event) => event.type === "response" && event.command === "prompt"),
			).toHaveLength(2);
			expect(
				await piAdapter.extractMetadata?.({ runId: "contract", workspacePath: root }),
			).toHaveProperty("session_id");
			expect(await readFile(join(root, "fixture.txt"), "utf8")).toBe("fixture content");
			await saveCapture(events, root);
		} finally {
			server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
