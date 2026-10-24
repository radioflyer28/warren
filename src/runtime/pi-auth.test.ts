import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionPiOAuth, readPiOAuth, removePiCredentials } from "./adapters/pi-auth.ts";

const roots: string[] = [];
const oauth = {
	type: "oauth",
	access: "test-access",
	refresh: "test-refresh",
	expires: 9999999999999,
	accountId: "selected",
};
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function fixture(contents: unknown) {
	const root = mkdtempSync(join(tmpdir(), "warren-auth-test-"));
	roots.push(root);
	const source = join(root, "operator.json");
	writeFileSync(source, JSON.stringify(contents));
	return { root, source, home: join(root, "home") };
}

test("copies only selected OAuth into a private writable run home; refresh never touches source", async () => {
	const f = fixture({
		openai: oauth,
		anthropic: { ...oauth, access: "unrelated" },
		"llama.cpp": { type: "api_key", key: "unrelated-key" },
	});
	const original = readFileSync(f.source, "utf8");
	expect(await provisionPiOAuth(f.home, f.source, "openai")).toBe(true);
	const path = join(f.home, ".pi", "agent", "auth.json");
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ openai: oauth });
	if (process.platform !== "win32") {
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(f.home, ".pi", "agent")).mode & 0o777).toBe(0o700);
	}
	writeFileSync(path, JSON.stringify({ openai: { ...oauth, access: "refreshed" } }));
	expect(readFileSync(f.source, "utf8")).toBe(original);
	await removePiCredentials(f.home);
	expect(existsSync(path)).toBe(false);
	expect(readFileSync(f.source, "utf8")).toBe(original);
});

test("absent source or matching OAuth preserves the ambient API-key path", async () => {
	const f = fixture({ openai: { type: "api_key", key: "do-not-copy" } });
	expect(await readPiOAuth(undefined, "openai")).toBeNull();
	expect(await provisionPiOAuth(f.home, f.source, "anthropic")).toBe(false);
	expect(await provisionPiOAuth(f.home, f.source, "openai")).toBe(false);
	expect(existsSync(f.home)).toBe(false);
});

test("malformed and unreadable configured files fail without leaking secret content", async () => {
	for (const value of [
		[],
		null,
		{ openai: { type: "oauth", access: "do-not-leak" } },
		{ openai: "bad" },
	]) {
		const f = fixture(value);
		await expect(readPiOAuth(f.source, "openai")).rejects.toThrow("WARREN_PI_AUTH_FILE");
		expect(existsSync(f.home)).toBe(false);
	}
	const f = fixture({});
	writeFileSync(f.source, "invalid secret JSON");
	await expect(readPiOAuth(f.source, "openai")).rejects.toThrow("readable Pi credential JSON");
	await expect(readPiOAuth(join(f.root, "missing"), "openai")).rejects.toThrow(
		"readable Pi credential JSON",
	);
});

test("provisioning refuses to overwrite an existing private credential", async () => {
	const f = fixture({ openai: oauth });
	await provisionPiOAuth(f.home, f.source, "openai");
	await expect(provisionPiOAuth(f.home, f.source, "openai")).rejects.toThrow();
	await removePiCredentials(f.home);
	await removePiCredentials(f.home);
});
