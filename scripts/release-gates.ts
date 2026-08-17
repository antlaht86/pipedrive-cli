import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { err, ok, Result } from "neverthrow";
import { z } from "zod";

/** Every recorded fixture carries this value, making accidental embedding grep-able. */
export const FIXTURE_CANARY = "pd-live-fixture-must-not-be-embedded-v1";

const RecordedFixture = z.object({
	method: z.literal("GET"),
	path: z.string().startsWith("/api/"),
	query: z.record(z.string(), z.union([z.string(), z.number()])),
	status: z.number().int(),
	body: z.unknown(),
});
export type RecordedFixture = z.infer<typeof RecordedFixture>;

const FixtureDocument = z.object({
	canary: z.literal(FIXTURE_CANARY),
	fixtures: z.array(RecordedFixture),
});
export type FixtureDocument = z.infer<typeof FixtureDocument>;

export const fixtureDocument = (
	fixtures: readonly RecordedFixture[],
): FixtureDocument => ({
	canary: FIXTURE_CANARY,
	fixtures: [...fixtures],
});

/**
 * Credential names are the reliable shape: a Pipedrive token and a custom-field
 * hash may both be forty hexadecimal characters, so a bare-value regex would
 * reject legitimate CRM schema. The recorder writes no request headers at all;
 * this catches any future edit that starts doing so.
 */
const CREDENTIAL_SHAPES = [
	/x-api-token/i,
	/pd_api_token/i,
	/\bapi[_-]?token\b/i,
	/\bauthorization\b/i,
	/\bbearer\s+[a-z0-9._~+/-]+/i,
] as const;

export const credentialLeak = (text: string): string | undefined =>
	CREDENTIAL_SHAPES.map((shape) => text.match(shape)?.[0]).find(
		(match) => match !== undefined,
	);

const fixtureFiles = (root: string): string[] => {
	const glob = new Bun.Glob("**/*");
	return [...glob.scanSync({ cwd: root, onlyFiles: true })].map((path) =>
		join(root, path),
	);
};

export const fixtureCredentialGate = (root: string): Result<void, string> => {
	for (const file of fixtureFiles(root)) {
		const text = readFileSync(file, "utf8");
		const leak = credentialLeak(text);
		if (leak !== undefined) {
			return err(`fixture credential gate: ${file} contains ${leak}`);
		}
	}
	return ok(undefined);
};

const VersionStamp = z.string().regex(
	/^\d+\.\d+\.\d+(?:\+g[0-9a-f]+(?:\.dirty)?)?$/,
);
const ManifestOutput = z.object({ pd_version: VersionStamp });
const AuthStatusOutput = z.object({
	found: z.literal(false),
	tier: z.never().optional(),
});
const parseJson = Result.fromThrowable(JSON.parse, (cause) => String(cause));
const parseOutput = <Output>(
	schema: z.ZodType<Output>,
	text: string,
): Result<Output, string> =>
	parseJson(text).andThen((value) => {
		const parsed = schema.safeParse(value);
		return parsed.success ? ok(parsed.data) : err(parsed.error.message);
	});

const withoutToken = (): Record<string, string> =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[0] !== "PD_API_TOKEN" && entry[1] !== undefined,
		),
	);

/** Artifact-only gates from ADR-0021 §3, §5, §6 and §8. */
export const binaryGate = (binaryPath: string): Result<void, string> => {
	const binary = resolve(binaryPath);
	const versionRun = Bun.spawnSync([binary, "--version"]);
	const manifestRun = Bun.spawnSync([binary, "manifest"]);
	const docsRun = Bun.spawnSync([binary, "docs"]);
	if (versionRun.exitCode !== 0 || manifestRun.exitCode !== 0) {
		return err("binary gate: version or manifest invocation failed");
	}
	const versionResult = VersionStamp.safeParse(
		versionRun.stdout.toString().trim(),
	);
	if (!versionResult.success) {
		return err("binary gate: --version is not a stamped release version");
	}
	const version = versionResult.data;
	const manifest = parseOutput(
		ManifestOutput,
		manifestRun.stdout.toString(),
	);
	if (manifest.isErr()) return err(`binary gate: ${manifest.error}`);
	if (manifest.value.pd_version !== version) {
		return err("binary gate: --version and manifest pd_version disagree");
	}

	const docs = readFileSync("AGENTS.md", "utf8");
	if (docsRun.exitCode !== 0 || docsRun.stdout.toString() !== docs) {
		return err("binary gate: pd docs does not equal AGENTS.md");
	}
	const executable = readFileSync(binary).toString("latin1");
	if (executable.includes(FIXTURE_CANARY)) {
		return err("binary gate: a live fixture is embedded in pd");
	}

	const workspace = mkdtempSync(join(tmpdir(), "pd-release-gate-"));
	const home = join(workspace, "home");
	writeFileSync(
		join(workspace, ".env"),
		"PD_API_TOKEN=leaked-from-dotenv\n",
	);
	const authRun = Bun.spawnSync([binary, "auth", "status"], {
		cwd: workspace,
		env: {
			...withoutToken(),
			HOME: home,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			APPDATA: join(home, "Roaming"),
			LOCALAPPDATA: join(home, "Local"),
		},
	});
	rmSync(workspace, { recursive: true, force: true });
	if (authRun.exitCode !== 0) {
		return err("binary gate: pd auth status failed beside a .env");
	}
	return parseOutput(AuthStatusOutput, authRun.stdout.toString()).map(
		() => undefined,
	);
};

const main = (): number => {
	const fixtureResult = fixtureCredentialGate("fixtures");
	if (fixtureResult.isErr()) {
		process.stderr.write(`${fixtureResult.error}\n`);
		return 1;
	}
	const binary = process.argv[2];
	if (binary !== undefined) {
		const binaryResult = binaryGate(binary);
		if (binaryResult.isErr()) {
			process.stderr.write(`${binaryResult.error}\n`);
			return 1;
		}
	}
	return 0;
};

if (import.meta.main) process.exitCode = main();
