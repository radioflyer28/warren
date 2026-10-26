import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A judge attempt owns its credential file; SDK refreshes never mutate the operator source. */
export function prepareJudgeAuth(provider: string, source?: string) {
	const directory = mkdtempSync(join(tmpdir(), "warren-judge-"));
	const authPath = join(directory, "auth.json");
	const cleanup = () => rmSync(directory, { recursive: true, force: true });
	try {
		const credentials: Record<string, unknown> = {};
		if (source) {
			const all: unknown = JSON.parse(readFileSync(source, "utf8"));
			if (!all || typeof all !== "object" || Array.isArray(all))
				throw new Error("invalid root");
			const selected = (all as Record<string, unknown>)[provider];
			if (selected !== undefined) {
				if (!selected || typeof selected !== "object" || Array.isArray(selected))
					throw new Error("invalid entry");
				const entry = selected as Record<string, unknown>;
				if (entry.type === "oauth") {
					if (
						typeof entry.access !== "string" ||
						!entry.access ||
						typeof entry.refresh !== "string" ||
						!entry.refresh ||
						typeof entry.expires !== "number" ||
						!Number.isFinite(entry.expires)
					)
						throw new Error("invalid OAuth");
					credentials[provider] = entry;
				} else if (entry.type !== "api_key" || typeof entry.key !== "string")
					throw new Error("invalid credential");
			}
		}
		writeFileSync(authPath, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
		return { authPath, directory, cleanup };
	} catch {
		cleanup();
		throw new Error(
			"JUDGE_PI_AUTH_FILE must be a readable Pi credential file with valid provider credentials",
		);
	}
}
