import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../sandbox/types.ts";
import { piAdapter } from "../adapters/pi.ts";
import type { RunSpec } from "../contract.ts";
import { driveLocalRun } from "./drive.ts";
import { LocalRunStore } from "./run-store.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const ack = {
	type: "response",
	id: "warren:initial",
	command: "prompt",
	success: true,
	data: { disposition: "started" },
};
const settled = { type: "agent_settled", aborted: false };
const turn = (stopReason: string) => ({
	type: "turn_end",
	message: {
		stopReason,
		errorMessage: stopReason === "error" ? "provider unavailable" : undefined,
	},
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "warren-pi-drive-"));
	roots.push(root);
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	const source = join(root, "operator.json");
	const credential = {
		openai: {
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: 9999999999999,
		},
	};
	await writeFile(source, JSON.stringify(credential));
	const store = new LocalRunStore();
	const record = store.create({
		runId: "pi-test",
		sandboxId: "pi-test",
		workspacePath: workspace,
		homePath: home,
		branch: "warren/pi-test",
	});
	const spec: RunSpec = {
		runId: "pi-test",
		originUrl: "file:///unused",
		branch: record.branch,
		baseBranch: "main",
		runtimeId: "pi",
		prompt: "test",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
		metadata: { frontmatter: { provider: "openai" } },
	};
	const profile = {
		workspace,
		home,
		readOnlyMounts: [],
		network: "open" as const,
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
	return { store, record, spec, profile, source, credential };
}

function fakeProcess(events: object[], exitCode: number) {
	let closed = false;
	const encoder = new TextEncoder();
	const proc: SpawnResult = {
		pid: 42,
		stdout: new ReadableStream({
			start(controller) {
				for (const event of events)
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		cancel() {},
		async closeStdin() {
			closed = true;
		},
		async writeStdin() {},
	};
	return { proc, closed: () => closed };
}

const cases: Array<[string, object[], number, "succeeded" | "failed" | "cancelled"]> = [
	["text success", [ack, turn("stop"), { type: "agent_end" }, settled], 0, "succeeded"],
	[
		"retry recovers",
		[
			ack,
			turn("error"),
			{ type: "agent_end", willRetry: true },
			{ type: "auto_retry_start" },
			turn("stop"),
			{ type: "agent_end" },
			settled,
		],
		0,
		"succeeded",
	],
	[
		"retry exhausted",
		[ack, turn("error"), { type: "agent_end", willRetry: false }, settled],
		0,
		"failed",
	],
	[
		"overflow recovers",
		[
			ack,
			turn("error"),
			{ type: "agent_end" },
			{ type: "compaction_end", result: {}, willRetry: true },
			turn("stop"),
			settled,
		],
		0,
		"succeeded",
	],
	["EOF before settlement", [ack, turn("stop"), { type: "agent_end" }], 0, "failed"],
	["process crash", [ack], 1, "failed"],
	["prompt rejected", [{ ...ack, success: false, error: "invalid prompt" }], 0, "failed"],
];
for (const phase of ["message_update", "tool_execution_start", "auto_retry_start"]) {
	cases.push([
		`cancel during ${phase}`,
		[ack, { type: phase }, { ...settled, aborted: true }],
		0,
		"cancelled",
	]);
}
test.each(cases)(
	"Pi driver: %s and private credential cleanup",
	async (_name, events, exitCode, phase) => {
		const f = await fixture();
		const child = fakeProcess(events, exitCode);
		await driveLocalRun(f.store, f.record, f.spec, f.profile, {
			piAuthFile: f.source,
			registry: { get: () => piAdapter },
			spawn: async () => {
				expect(
					JSON.parse(await readFile(join(f.record.homePath, ".pi/agent/auth.json"), "utf8")),
				).toEqual(f.credential);
				return child.proc;
			},
		});
		expect(f.record.phase).toBe(phase);
		expect(child.closed()).toBe(true);
		expect(await Bun.file(join(f.record.homePath, ".pi/agent/auth.json")).exists()).toBe(false);
		expect(JSON.parse(await readFile(f.source, "utf8"))).toEqual(f.credential);
	},
);

test("Pi credentials are removed when spawn fails", async () => {
	const f = await fixture();
	await driveLocalRun(f.store, f.record, f.spec, f.profile, {
		piAuthFile: f.source,
		registry: { get: () => piAdapter },
		spawn: async () => {
			throw new Error("spawn failed");
		},
	});
	expect(f.record.phase).toBe("failed");
	expect(await Bun.file(join(f.record.homePath, ".pi/agent/auth.json")).exists()).toBe(false);
});
