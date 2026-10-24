import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJudgeAuth } from "./pi-auth.ts";

test.each([false, true])(
	"SDK OAuth refresh stays private and never falls back after failure=%s",
	async (fail) => {
		const root = mkdtempSync(join(tmpdir(), "judge-refresh-"));
		const source = join(root, "operator.json");
		const original = JSON.stringify({
			openai: {
				type: "oauth",
				access: "expired-token",
				refresh: "test-refresh",
				expires: 0,
				accountId: "test-account",
			},
		});
		writeFileSync(source, original);
		const copy = prepareJudgeAuth("openai", source);
		try {
			const runtime = await ModelRuntime.create({
				authPath: copy.authPath,
				modelsPath: null,
				modelsStorePath: join(root, "models"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const provider = runtime.getProviders().find((entry) => entry.id === "openai");
			if (!provider?.auth.oauth) throw new Error("Expected OpenAI OAuth support");
			runtime.registerNativeProvider({
				...provider,
				auth: {
					...provider.auth,
					oauth: {
						...provider.auth.oauth,
						refresh: async (credential) => {
							if (fail) throw new Error("controlled refresh failure");
							return {
								...credential,
								access: "refreshed-private-token",
								expires: Date.now() + 3600000,
							};
						},
						toAuth: async (credential) => ({ apiKey: credential.access }),
					},
				},
			});
			const result = runtime.getAuth("openai", {
				env: { OPENAI_API_KEY: "ambient-must-not-win" },
			});
			if (fail) {
				await expect(result).rejects.toThrow("OAuth refresh failed");
			} else {
				expect((await result)?.auth.apiKey).toBe("refreshed-private-token");
				expect(JSON.parse(readFileSync(copy.authPath, "utf8")).openai.access).toBe(
					"refreshed-private-token",
				);
			}
			expect(readFileSync(source, "utf8")).toBe(original);
		} finally {
			copy.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
