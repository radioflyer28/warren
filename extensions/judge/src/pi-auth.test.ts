import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJudgeAuth } from "./pi-auth.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("judge credential copies are selected, private, refreshable, disposable", () => {
	const root = mkdtempSync(join(tmpdir(), "judge-auth-test-"));
	roots.push(root);
	const source = join(root, "source.json");
	const credential = {
		type: "oauth",
		access: "test",
		refresh: "test-refresh",
		expires: 9999999999999,
	};
	writeFileSync(
		source,
		JSON.stringify({ openai: credential, anthropic: { type: "api_key", key: "unrelated" } }),
	);
	const before = readFileSync(source, "utf8");
	const auth = prepareJudgeAuth("openai", source);
	try {
		expect(JSON.parse(readFileSync(auth.authPath, "utf8"))).toEqual({ openai: credential });
		if (process.platform !== "win32") expect(statSync(auth.authPath).mode & 0o777).toBe(0o600);
		writeFileSync(
			auth.authPath,
			JSON.stringify({ openai: { ...credential, access: "refreshed" } }),
		);
		expect(readFileSync(source, "utf8")).toBe(before);
	} finally {
		auth.cleanup();
	}
	expect(existsSync(auth.directory)).toBe(false);
	const fallback = prepareJudgeAuth("missing-provider", source);
	try {
		expect(readFileSync(fallback.authPath, "utf8")).toBe("{}");
	} finally {
		fallback.cleanup();
	}
});

test("judge rejects malformed configured files", () => {
	const root = mkdtempSync(join(tmpdir(), "judge-auth-bad-"));
	roots.push(root);
	const source = join(root, "source.json");
	for (const content of ["not json", "[]", '{"openai":{"type":"oauth"}}']) {
		writeFileSync(source, content);
		expect(() => prepareJudgeAuth("openai", source)).toThrow("JUDGE_PI_AUTH_FILE");
	}
	expect(() => prepareJudgeAuth("openai", join(root, "missing"))).toThrow("JUDGE_PI_AUTH_FILE");
});
