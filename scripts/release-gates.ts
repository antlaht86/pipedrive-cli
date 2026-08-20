import { dirname, join, posix, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { z } from "zod";

import { createManifest } from "../src/command-table.ts";
import { WARNING_KINDS } from "../src/lib/warnings.ts";
import { parseRequiredSingleArgument } from "./arguments.ts";
import {
	makeDirectory,
	readBytes,
	readText,
	runProcessSync,
	withTempDirectory,
	writeStderr,
	writeText,
} from "./result-io.ts";

/** Every recorded fixture carries this value, making accidental embedding grep-able. */
export const FIXTURE_CANARY = "pd-live-fixture-must-not-be-embedded-v1";

const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;
/**
 * The recording format `bun run live` writes. Nothing parses it any more — ADR-0032 §2
 * deleted the last reader — so it is a plain type rather than a zod schema.
 */
export type RecordedFixture = {
	method: "GET";
	path: string;
	query: Record<string, string | number>;
	status: number;
	body: JsonValue;
};

export type FixtureDocument = {
	canary: typeof FIXTURE_CANARY;
	fixtures: RecordedFixture[];
};

export const fixtureDocument = (
	fixtures: readonly RecordedFixture[],
): FixtureDocument => ({
	canary: FIXTURE_CANARY,
	fixtures: [...fixtures],
});

const stringifyJson = Result.fromThrowable(
	(value: JsonValue, space?: number) => JSON.stringify(value, null, space),
	(cause) => `JSON serialization failed: ${String(cause)}`,
);
export const serializeFixtureDocument = (
	document: FixtureDocument,
): ResultType<string, string> =>
	stringifyJson(document, 2).map((text) => `${text}\n`);

const parseJson = Result.fromThrowable(JSON.parse, (cause) => String(cause));

/**
 * The binary-exclusion gate, per ADR-0032 §1. The needle is the canary constant and
 * nothing else: `bun run live` stamps it into every recording it writes, so a build
 * that embedded one would carry it. It proves no recording is in the binary. It does
 * not prove that no arbitrary response body is — see ADR-0032 §1 for what was given up.
 */
export const binaryEmbedsRecording = (executable: Uint8Array): boolean =>
	Buffer.from(executable).includes(Buffer.from(FIXTURE_CANARY));

const VersionStamp = z
	.string()
	.regex(/^\d+\.\d+\.\d+(?:\+g[0-9a-f]+(?:\.dirty)?)?$/);
const WarningOutput = z
	.object({
		kind: z.enum(WARNING_KINDS),
		message: z.string(),
	})
	.catchall(JsonValueSchema);
const MissingAuthOutput = z
	.object({
		found: z.literal(false),
		cache_dir_exists: z.boolean(),
		credential_is_write_capable: z.literal(false),
		warnings: z.array(WarningOutput),
	})
	.strict();
const FileAuthOutput = z
	.object({
		found: z.literal(true),
		tier: z.literal("config-file"),
		path: z.string(),
		fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
		cache_dir_exists: z.boolean(),
		credential_is_write_capable: z.literal(true),
		warnings: z.array(WarningOutput),
	})
	.strict();
const parseOutput = <Output>(
	schema: z.ZodType<Output>,
	text: string,
): ResultType<Output, string> =>
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

export type CredentialRoots = { xdg: string; appData: string };
export const expectedCredentialPath = (
	platform: NodeJS.Platform,
	roots: CredentialRoots,
): string =>
	platform === "win32"
		? win32.join(roots.appData, "pd", "credentials")
		: posix.join(roots.xdg, "pd", "credentials");

const checkPlatformCredentialPath = (
	binary: string,
	workspace: string,
	env: Record<string, string>,
): ResultType<void, string> => {
	const roots = {
		xdg: join(workspace, "xdg"),
		appData: join(workspace, "AppData"),
	};
	const posixCredential = join(roots.xdg, "pd", "credentials");
	const windowsCredential = join(roots.appData, "pd", "credentials");
	const expected = expectedCredentialPath(process.platform, roots);
	return makeDirectory(dirname(posixCredential))
		.andThen(() => makeDirectory(dirname(windowsCredential)))
		.andThen(() =>
			writeText(posixCredential, "posix-path-token\n", { mode: 0o600 }),
		)
		.andThen(() =>
			writeText(windowsCredential, "windows-path-token\n", { mode: 0o600 }),
		)
		.andThen(() =>
			runProcessSync([binary, "auth", "status"], {
				cwd: workspace,
				env: {
					...env,
					XDG_CONFIG_HOME: roots.xdg,
					APPDATA: roots.appData,
				},
			}),
		)
		.andThen((run) => {
			if (run.exitCode !== 0) {
				return err("binary gate: platform credential-path probe failed");
			}
			return parseOutput(FileAuthOutput, run.stdout.toString()).andThen(
				(status) =>
					status.path === expected
						? ok(undefined)
						: err(
								`binary gate: expected credential path ${expected}, got ${status.path}`,
							),
			);
		});
};

const checkVersionAndDocs = (binary: string): ResultType<void, string> =>
	runProcessSync([binary, "--version"]).andThen((versionRun) =>
		runProcessSync([binary, "manifest"]).andThen((manifestRun) =>
			runProcessSync([binary, "docs"]).andThen((docsRun) => {
				if (versionRun.exitCode !== 0 || manifestRun.exitCode !== 0) {
					return err("binary gate: version or manifest invocation failed");
				}
				const version = VersionStamp.safeParse(
					versionRun.stdout.toString().trim(),
				);
				if (!version.success) {
					return err("binary gate: --version is not a stamped release version");
				}
				const manifest = parseOutput(
					JsonValueSchema,
					manifestRun.stdout.toString(),
				);
				if (manifest.isErr()) return err(`binary gate: ${manifest.error}`);
				const expectedManifest = JsonValueSchema.safeParse(
					createManifest(version.data),
				);
				if (
					!expectedManifest.success ||
					!isDeepStrictEqual(manifest.value, expectedManifest.data)
				) {
					return err(
						"binary gate: manifest does not match this binary version",
					);
				}
				const docs = readText("AGENTS.md");
				if (docs.isErr()) return err(`binary gate: ${docs.error}`);
				return docsRun.exitCode === 0 &&
					docsRun.stdout.toString() === docs.value
					? ok(undefined)
					: err("binary gate: pd docs does not equal AGENTS.md");
			}),
		),
	);

const checkRecordingExclusion = (binary: string): ResultType<void, string> =>
	readBytes(binary).andThen((executable) =>
		binaryEmbedsRecording(executable)
			? err("binary gate: the binary carries the live-recording canary")
			: ok(undefined),
	);

const checkCredentialSafety = (binary: string): ResultType<void, string> =>
	withTempDirectory("pd-release-gate-", (workspace) => {
		const home = join(workspace, "home");
		const env = {
			...withoutToken(),
			HOME: home,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			APPDATA: join(home, "Roaming"),
			LOCALAPPDATA: join(home, "Local"),
		};
		return writeText(
			join(workspace, ".env"),
			"PD_API_TOKEN=leaked-from-dotenv\n",
		)
			.andThen(() =>
				runProcessSync([binary, "auth", "status"], { cwd: workspace, env }),
			)
			.andThen((authRun) => {
				if (authRun.exitCode !== 0) {
					return err("binary gate: pd auth status failed beside a .env");
				}
				return parseOutput(MissingAuthOutput, authRun.stdout.toString()).map(
					() => undefined,
				);
			})
			.andThen(() => checkPlatformCredentialPath(binary, workspace, env));
	});

/** Artifact-only gates from ADR-0021 §3, §5, §6 and §8. */
export const binaryGate = (binaryPath: string): ResultType<void, string> => {
	const binary = resolve(binaryPath);
	return checkVersionAndDocs(binary)
		.andThen(() => checkRecordingExclusion(binary))
		.andThen(() => checkCredentialSafety(binary));
};

export const parseGateArguments = (
	args: readonly string[],
): ResultType<string, string> =>
	parseRequiredSingleArgument(args, z.string().min(1)).mapErr(() =>
		"exactly one binary path is required",
	);

const main = (args: readonly string[]): number => {
	const parsed = parseGateArguments(args);
	if (parsed.isErr()) {
		const reported = writeStderr(
			`Usage: bun run gates <binary-path>\n${parsed.error}\n`,
		);
		return reported.isErr() ? 1 : 2;
	}
	const result = binaryGate(parsed.value);
	if (result.isErr()) {
		return writeStderr(`${result.error}\n`)
			.map(() => 1)
			.unwrapOr(1);
	}
	return 0;
};

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
