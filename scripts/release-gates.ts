import { dirname, join, posix, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { z } from "zod";

import { createManifest } from "../src/command-table.ts";
import { WARNING_KINDS } from "../src/lib/warnings.ts";
import { parseOptionalSingleArgument } from "./arguments.ts";
import {
	makeDirectory,
	readBytes,
	readText,
	scanFiles,
	runProcessSync,
	withTempDirectory,
	writeStderr,
	writeText,
} from "./result-io.ts";

/** Every recorded fixture carries this value, making accidental embedding grep-able. */
export const FIXTURE_CANARY = "pd-live-fixture-must-not-be-embedded-v1";

const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;
const RecordedFixtureSchema = z
	.object({
		method: z.literal("GET"),
		path: z.string().startsWith("/api/"),
		query: z.record(z.string(), z.union([z.string(), z.number()])),
		status: z.number().int(),
		body: JsonValueSchema,
	})
	.strict();
export type RecordedFixture = z.infer<typeof RecordedFixtureSchema>;

const FixtureDocumentSchema = z
	.object({
		canary: z.literal(FIXTURE_CANARY),
		fixtures: z.array(RecordedFixtureSchema),
	})
	.strict();
export type FixtureDocument = z.infer<typeof FixtureDocumentSchema>;

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

const CREDENTIAL_METADATA = [
	/x-api-token/i,
	/pd_api_token/i,
	/\bapi[_-]?token\b/i,
	/\bauthorization\b/i,
	/\bbearer\s+[a-z0-9._~+/-]+/i,
] as const;
const TOKEN_VALUES = /([a-z0-9]{40})/gi;
const CUSTOM_FIELD_HASH = /^[a-f0-9]{40}$/i;
const parseJson = Result.fromThrowable(JSON.parse, (cause) => String(cause));

const credentialValue = (
	value: JsonValue,
	allowedHashes: ReadonlySet<string>,
): string | undefined => {
	if (typeof value === "string") {
		return [...value.matchAll(TOKEN_VALUES)]
			.map((match) => match[1])
			.find(
				(token): token is string =>
					token !== undefined && !allowedHashes.has(token),
			);
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const leak = credentialValue(item, allowedHashes);
			if (leak !== undefined) return leak;
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	for (const [childKey, child] of Object.entries(value)) {
		const keyToken = [...childKey.matchAll(TOKEN_VALUES)]
			.map((match) => match[1])
			.find(
				(token): token is string =>
					token !== undefined && !allowedHashes.has(token),
			);
		if (keyToken !== undefined) return keyToken;
		const leak = credentialValue(child, allowedHashes);
		if (leak !== undefined) return leak;
	}
	return undefined;
};

/** Detect both credential metadata and a bare token stored as a JSON value. */
export const credentialLeak = (
	text: string,
	allowedHashes: ReadonlySet<string> = new Set(),
): string | undefined => {
	const metadata = CREDENTIAL_METADATA.map(
		(shape) => text.match(shape)?.[0],
	).find((match) => match !== undefined);
	if (metadata !== undefined) return metadata;
	return parseJson(text).match(
		(value) => {
			const json = JsonValueSchema.safeParse(value);
			return json.success
				? credentialValue(json.data, allowedHashes)
				: [...text.matchAll(TOKEN_VALUES)][0]?.[1];
		},
		() => [...text.matchAll(TOKEN_VALUES)][0]?.[1],
	);
};

type FixtureFile = { path: string; bytes: Buffer; text: string };
const fixtureFiles = (root: string): ResultType<FixtureFile[], string> =>
	scanFiles(root).andThen((files) => {
		const contents: FixtureFile[] = [];
		for (const file of files) {
			const bytes = readBytes(file);
			if (bytes.isErr()) return err(`fixture gate: ${file}: ${bytes.error}`);
			contents.push({
				path: file,
				bytes: bytes.value,
				text: bytes.value.toString("utf8"),
			});
		}
		return ok(contents);
	});

const FIELD_SCHEMA_PATH =
	/^\/api\/v2\/(?:deal|person|organization|activity|product)Fields$/;
const FieldDefinitionResponse = z
	.object({
		field_code: z.string().regex(CUSTOM_FIELD_HASH),
		field_name: z.string(),
		field_type: z.string(),
		is_custom_field: z.boolean(),
	})
	.catchall(JsonValueSchema);
const FieldEnvelopeResponse = z
	.object({
		success: z.literal(true),
		data: z.array(FieldDefinitionResponse),
	})
	.catchall(JsonValueSchema);

const allowedFieldHashes = (files: readonly FixtureFile[]): Set<string> => {
	const hashes = new Set<string>();
	for (const file of files) {
		const parsedJson = parseJson(file.text);
		if (parsedJson.isErr()) continue;
		const document = FixtureDocumentSchema.safeParse(parsedJson.value);
		if (!document.success) continue;
		for (const fixture of document.data.fixtures) {
			if (fixture.status !== 200 || !FIELD_SCHEMA_PATH.test(fixture.path)) continue;
			const envelope = FieldEnvelopeResponse.safeParse(fixture.body);
			if (!envelope.success) continue;
			for (const field of envelope.data.data) {
				if (field.is_custom_field) hashes.add(field.field_code);
			}
		}
	}
	return hashes;
};

/** Credential scanning is format-independent and covers every fixture-tree file. */
export const fixtureCredentialGate = (root: string): ResultType<void, string> =>
	fixtureFiles(root).andThen((files) => {
		const allowedHashes = allowedFieldHashes(files);
		for (const file of files) {
			if (credentialLeak(file.text, allowedHashes) !== undefined) {
				return err(
					`fixture credential gate: ${file.path} contains credential-shaped data`,
				);
			}
		}
		return ok(undefined);
	});

export type FixtureInspection = {
	documents: FixtureDocument[];
	rawContents: Uint8Array[];
};
const inspectFixtureTree = (
	root: string,
): ResultType<FixtureInspection, string> =>
	fixtureFiles(root).andThen((files) => {
		if (files.length === 0) return err("fixture gate: fixture tree is empty");
		const documents: FixtureDocument[] = [];
		for (const file of files) {
			const parsedJson = parseJson(file.text);
			if (parsedJson.isErr()) continue;
			const document = FixtureDocumentSchema.safeParse(parsedJson.value);
			if (document.success) documents.push(document.data);
		}
		if (documents.length === 0) {
			return err("fixture gate: no live fixture document found");
		}
		return ok({
			documents,
			rawContents: files.map((file) => file.bytes),
		});
	});

type BinaryNeedle = { label: string; bytes: Buffer };
const fixtureNeedles = (
	inspection: FixtureInspection,
): ResultType<BinaryNeedle[], string> => {
	const needles: BinaryNeedle[] = [
		{ label: "fixture canary", bytes: Buffer.from(FIXTURE_CANARY) },
		...inspection.rawContents.flatMap((bytes) =>
			bytes.byteLength > 0
				? [{ label: "raw fixture file", bytes: Buffer.from(bytes) }]
				: [],
		),
	];
	const addJsonNeedle = (label: string, value: JsonValue): ResultType<void, string> =>
		stringifyJson(value).map((text) => {
			needles.push({ label, bytes: Buffer.from(text) });
			return undefined;
		});
	for (const document of inspection.documents) {
		const documentNeedle = addJsonNeedle(
			"compacted fixture document",
			document,
		);
		if (documentNeedle.isErr()) return err(documentNeedle.error);
		for (const fixture of document.fixtures) {
			const responseNeedle = addJsonNeedle(
				"compacted fixture response",
				fixture,
			);
			if (responseNeedle.isErr()) return err(responseNeedle.error);
			const bodyNeedle = addJsonNeedle("fixture response body", fixture.body);
			if (bodyNeedle.isErr()) return err(bodyNeedle.error);
		}
	}
	return ok(needles);
};

export const binaryContainsFixture = (
	executable: Uint8Array,
	inspection: FixtureInspection,
): ResultType<string | undefined, string> =>
	fixtureNeedles(inspection).map((needles) => {
		const binary = Buffer.from(executable);
		return needles.find((needle) => binary.includes(needle.bytes))?.label;
	});

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
		.andThen(() => writeText(posixCredential, "posix-path-token\n", { mode: 0o600 }))
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
					return err("binary gate: manifest does not match this binary version");
				}
				const docs = readText("AGENTS.md");
				if (docs.isErr()) return err(`binary gate: ${docs.error}`);
				return docsRun.exitCode === 0 && docsRun.stdout.toString() === docs.value
					? ok(undefined)
					: err("binary gate: pd docs does not equal AGENTS.md");
			}),
		),
	);

const checkFixtureExclusion = (
	binary: string,
	inspection: FixtureInspection,
): ResultType<void, string> =>
	readBytes(binary).andThen((executable) =>
		binaryContainsFixture(executable, inspection).andThen((embedded) =>
			embedded === undefined
				? ok(undefined)
				: err(`binary gate: embedded fixture content: ${embedded}`),
		),
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
				return parseOutput(
					MissingAuthOutput,
					authRun.stdout.toString(),
				).map(() => undefined);
			})
			.andThen(() => checkPlatformCredentialPath(binary, workspace, env));
	});

/** Artifact-only gates from ADR-0021 §3, §5, §6 and §8. */
export const binaryGate = (binaryPath: string): ResultType<void, string> => {
	const binary = resolve(binaryPath);
	return fixtureCredentialGate("fixtures")
		.andThen(() => inspectFixtureTree("fixtures"))
		.andThen((inspection) =>
			checkVersionAndDocs(binary)
				.andThen(() => checkFixtureExclusion(binary, inspection))
				.andThen(() => checkCredentialSafety(binary)),
		);
};

export const parseGateArguments = (
	args: readonly string[],
): ResultType<string | undefined, string> =>
	parseOptionalSingleArgument(args, z.string().min(1), undefined);

const main = (args: readonly string[]): number => {
	const parsed = parseGateArguments(args);
	if (parsed.isErr()) {
		const reported = writeStderr(
			`Usage: bun run gates [binary-path]\n${parsed.error}\n`,
		);
		return reported.isErr() ? 1 : 2;
	}
	const result = parsed.value === undefined
		? fixtureCredentialGate("fixtures")
		: binaryGate(parsed.value);
	if (result.isErr()) {
		return writeStderr(`${result.error}\n`).map(() => 1).unwrapOr(1);
	}
	return 0;
};

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
