import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function assertPiAuthSupported(backend: string, source: string | undefined): void {
	if (backend === "k8s" && source) {
		throw new Error("WARREN_PI_AUTH_FILE is unsupported for Kubernetes; use API-key provisioning");
	}
}

/** Only a trusted operator setting may select this file; never use repository metadata. */
export async function readPiOAuth(
	source: string | undefined,
	provider: string,
): Promise<Record<string, unknown> | null> {
	if (!source) return null;
	let data: unknown;
	try {
		data = JSON.parse(await readFile(source, "utf8"));
	} catch {
		throw new Error("WARREN_PI_AUTH_FILE must be a readable Pi credential JSON file");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("WARREN_PI_AUTH_FILE must contain a provider credential object");
	}
	const selected = (data as Record<string, unknown>)[provider];
	if (selected === undefined) return null;
	if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
		throw new Error("WARREN_PI_AUTH_FILE contains a malformed provider credential");
	}
	const credential = selected as Record<string, unknown>;
	if (credential.type === "api_key" && typeof credential.key === "string") return null;
	if (
		credential.type !== "oauth" ||
		typeof credential.access !== "string" ||
		typeof credential.refresh !== "string" ||
		typeof credential.expires !== "number" ||
		!Number.isFinite(credential.expires) ||
		!credential.access ||
		!credential.refresh
	) {
		throw new Error("WARREN_PI_AUTH_FILE contains a malformed OAuth credential");
	}
	return credential;
}

export async function provisionPiOAuth(
	home: string,
	source: string | undefined,
	provider: string,
): Promise<boolean> {
	const credential = await readPiOAuth(source, provider);
	if (!credential) return false;
	const parent = join(home, ".pi");
	const directory = join(parent, "agent");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "auth.json"), JSON.stringify({ [provider]: credential }), {
		mode: 0o600,
		flag: "wx",
	});
	return true;
}

/** Remove the private tree itself, without following any agent-created symlinks inside it. */
export async function removePiCredentials(home: string): Promise<void> {
	await rm(join(home, ".pi"), { recursive: true, force: true });
}
