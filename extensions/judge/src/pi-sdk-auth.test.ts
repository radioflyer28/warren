import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJudgeAuth } from "./pi-auth.ts";

test("real Pi SDK selects private OpenAI OAuth before an ambient API key", async () => {
	const root = mkdtempSync(join(tmpdir(), "judge-precedence-"));
	const source = join(root, "operator.json");
	writeFileSync(
		source,
		JSON.stringify({
			openai: {
				type: "oauth",
				access: "selected-oauth",
				refresh: "test-refresh",
				expires: Date.now() + 3600000,
				accountId: "test-account",
			},
		}),
	);
	const copy = prepareJudgeAuth("openai", source);
	try {
		const runtime = await ModelRuntime.create({
			authPath: copy.authPath,
			modelsPath: null,
			modelsStorePath: join(root, "models"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const auth = await runtime.getAuth("openai", {
			env: { OPENAI_API_KEY: "ambient-key-must-not-win" },
		});
		expect(JSON.stringify(auth)).toContain("selected-oauth");
		expect(JSON.stringify(auth)).not.toContain("ambient-key-must-not-win");
	} finally {
		copy.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
