/**
 * Hand-invoked live fixture recorder — ADR-0019 §9.
 *
 * This file is deliberately outside `test/`, is never imported by CI, and is
 * reached only through `bun run live`. It records real response bodies through
 * the same guarded transport as production, supplies a hard request ceiling,
 * and prints a git diff rather than comparing values or declaring a pass.
 * Retry-provoking responses are converted to `PdFailure` before guardedFetch
 * can retry them: the live suite never exercises 429, 5xx or Cloudflare paths.
 */

import { join } from "node:path";

import {
	err,
	ok,
	okAsync,
	Result,
	ResultAsync,
	type Result as ResultType,
} from "neverthrow";
import { z } from "zod";

import {
	ERROR_CODES,
	pdError,
	type ErrorCode,
	type ExitCode,
} from "../src/lib/errors.ts";
import { PdFailure } from "../src/lib/pipedrive/failure.ts";
import type { Transport } from "../src/lib/pipedrive/guarded-fetch.ts";
import { route } from "../src/router.ts";
import { parseOptionalSingleArgument } from "./arguments.ts";
import {
	fixtureDocument,
	serializeFixtureDocument,
	type RecordedFixture,
} from "./release-gates.ts";
import {
	homeDirectory,
	runProcessSync,
	withTempDirectoryAsync,
	writeStderr,
	writeStdout,
	writeText,
} from "./result-io.ts";

const parseJson = Result.fromThrowable(JSON.parse, (cause) => String(cause));
const RequestUrl = z
	.url()
	.transform((value) => URL.parse(value))
	.pipe(z.instanceof(URL));
const JsonBody = z.json();

const failure = (message: string, code: ErrorCode): PdFailure =>
	new PdFailure(pdError({ code, message }));

const transportFailure = (cause: unknown): PdFailure =>
	cause instanceof PdFailure
		? cause
		: failure(
				`The live recorder transport failed: ${String(cause)}`,
				"upstream",
			);

export type RecordingTransportOptions = {
	recorded: RecordedFixture[];
	maxRequests: number;
	upstream?: Transport;
};

/** A recorder below guardedFetch: request headers are observed but never stored. */
export const createRecordingTransport = ({
	recorded,
	maxRequests,
	upstream = globalThis.fetch,
}: RecordingTransportOptions): Transport => {
	let requests = 0;
	return (request) => {
		if (request.method !== "GET") {
			return Promise.reject(
				failure(
					"The live recorder refused a non-GET request.",
					"write_blocked",
				),
			);
		}
		if (requests >= maxRequests) {
			return Promise.reject(
				failure(
					"The live recorder reached its request ceiling.",
					"request_ceiling",
				),
			);
		}
		requests += 1;
		return upstream(request).then(
			(response) => {
				if (
					response.status === 429 ||
					response.status === 403 ||
					response.status >= 500
				) {
					return Promise.reject(
						failure(
							`The live recorder stopped at HTTP ${response.status}; it will not exercise a retry path.`,
							"upstream",
						),
					);
				}
				return response.text().then(
					(text) => {
						const parsed = parseJson(text).andThen((value) => {
							const body = JsonBody.safeParse(value);
							return body.success ? ok(body.data) : err(body.error.message);
						});
						if (parsed.isErr()) {
							return Promise.reject(
								failure(
									`The live recorder received non-JSON: ${parsed.error}`,
									"upstream",
								),
							);
						}
						const url = RequestUrl.safeParse(request.url);
						if (!url.success) {
							return Promise.reject(
								failure(
									`The live recorder received an invalid URL: ${url.error.message}`,
									"internal",
								),
							);
						}
						recorded.push({
							method: "GET",
							path: url.data.pathname,
							query: Object.fromEntries(url.data.searchParams),
							status: response.status,
							body: parsed.value,
						});
						return new Response(text, {
							status: response.status,
							headers: response.headers,
						});
					},
					(cause: unknown) => Promise.reject(transportFailure(cause)),
				);
			},
			(cause: unknown) => Promise.reject(transportFailure(cause)),
		);
	};
};

const MAX_REQUESTS = 30;
const FIXTURE_PATH = "fixtures/live/responses.json";
const LISTS = ["deals", "persons", "organizations", "activities", "products"];
const SEARCHES = ["deals", "persons", "organizations", "products", "items"];
const CACHED = ["pipelines", "stages", "users"];
const FIELD_ENTITIES = [
	"deal",
	"person",
	"organization",
	"activity",
	"product",
];

const commands = (term: string): string[][] => [
	...LISTS.map((resource) => [resource, "list", "--limit", "20"]),
	...CACHED.map((resource) => [resource, "list"]),
	...FIELD_ENTITIES.map((entity) => ["fields", "list", "--entity", entity]),
	...SEARCHES.map((resource) => [resource, "search", term, "--limit", "20"]),
];

const CommandErrorTrailer = z
	.object({
		type: z.literal("error"),
		code: z.enum(ERROR_CODES),
		message: z.string(),
		exit_code: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		retry: z.enum(["never", "after", "not_today"]),
		retry_after_seconds: z.number().optional(),
		complete: z.literal(false),
		emitted: z.number().int().nonnegative(),
		skipped: z.number().int().nonnegative(),
		duplicates: z.number().int().nonnegative(),
		resolved: z.enum(["off", "partial", "full"]),
		requests: z.number().int().nonnegative(),
		details: z.record(z.string(), JsonBody).optional(),
	})
	.strict();

type CommandOutcome =
	| { kind: "success"; exit: 0 }
	| {
			kind: "failure";
			exit: ExitCode;
			recordableDrift: boolean;
	  };
export const classifyCommand = (
	exit: number,
	output: string,
): ResultType<CommandOutcome, string> => {
	if (exit === 0) return ok({ kind: "success", exit });
	const line = output
		.split("\n")
		.filter((candidate) => candidate !== "")
		.at(-1);
	if (line === undefined)
		return err("live command failed without an error trailer");
	const parsed = parseJson(line).andThen((value) => {
		const json = JsonBody.safeParse(value);
		return json.success ? ok(json.data) : err(json.error.message);
	});
	if (parsed.isErr())
		return err(`live command output was invalid: ${parsed.error}`);
	const trailer = CommandErrorTrailer.safeParse(parsed.value);
	if (!trailer.success)
		return err("live command did not end in an error trailer");
	if (trailer.data.exit_code !== exit) {
		return err("live command exit code disagreed with its error trailer");
	}
	return ok({
		kind: "failure",
		exit: trailer.data.exit_code,
		recordableDrift: ["invalid_response", "not_found", "internal"].includes(
			trailer.data.code,
		),
	});
};

type RunCommand = (
	argv: readonly string[],
) => ResultAsync<CommandOutcome, string>;
type PersistRecording = () => ResultType<void, string>;

type RunOutcome =
	| { kind: "complete" }
	| { kind: "command-failure"; exit: ExitCode };
const runUntilStop = (
	pending: readonly string[][],
	recorded: readonly RecordedFixture[],
	runCommand: RunCommand,
): ResultAsync<RunOutcome, string> => {
	const [next, ...rest] = pending;
	if (next === undefined) {
		return okAsync<RunOutcome>({ kind: "complete" });
	}
	const before = recorded.length;
	return runCommand(next).andThen((outcome) => {
		if (outcome.kind === "success") {
			return runUntilStop(rest, recorded, runCommand);
		}
		const responseRecorded = recorded.length > before;
		return outcome.recordableDrift && responseRecorded
			? runUntilStop(rest, recorded, runCommand)
			: okAsync<RunOutcome>({
					kind: "command-failure",
					exit: outcome.exit,
				});
	});
};

/** Persist API drift as data rather than turning a changed response into a test failure. */
export const completeRecording = (
	pending: readonly string[][],
	recorded: readonly RecordedFixture[],
	runCommand: RunCommand,
	persist: PersistRecording,
): ResultAsync<number, string> =>
	runUntilStop(pending, recorded, runCommand).andThen((outcome) =>
		outcome.kind === "command-failure"
			? okAsync(outcome.exit)
			: persist().map(() => 0),
	);

const persistRecording = (
	recorded: readonly RecordedFixture[],
): ResultType<void, string> =>
	serializeFixtureDocument(fixtureDocument(recorded))
		.andThen((text) => writeText(FIXTURE_PATH, text))
		.andThen(() => runProcessSync(["git", "diff", "--", FIXTURE_PATH]))
		.andThen((diff) =>
			writeStdout(
				`re-recorded ${recorded.length} responses in ${FIXTURE_PATH}\n`,
			)
				.andThen(() => writeStdout(diff.stdout))
				.andThen(() => writeStderr(diff.stderr))
				.andThen(() =>
					diff.exitCode === 0
						? ok(undefined)
						: err(`git diff failed with exit ${diff.exitCode}`),
				),
		);

export const runLive = (term: string): ResultAsync<number, string> =>
	homeDirectory().asyncAndThen((home) =>
		withTempDirectoryAsync("pd-live-", (workspace) => {
			const recorded: RecordedFixture[] = [];
			const transport = createRecordingTransport({
				recorded,
				maxRequests: MAX_REQUESTS,
			});
			const env = {
				...process.env,
				XDG_CACHE_HOME: join(workspace, "cache"),
				LOCALAPPDATA: join(workspace, "Local"),
			};
			return completeRecording(
				commands(term),
				recorded,
				(argv) => {
					const output: string[] = [];
					return ResultAsync.fromPromise(
						route({
							argv: [...argv, "--max-requests", String(MAX_REQUESTS)],
							platform: process.platform,
							env,
							home,
							transport,
							sink: (text) => {
								output.push(text);
							},
							stderr: () => undefined,
							isTty: () => false,
						}),
						(cause) => `live command failed: ${String(cause)}`,
					).andThen((exit) => classifyCommand(exit, output.join("")));
				},
				() => persistRecording(recorded),
			);
		}),
	);

export const parseLiveArguments = (
	args: readonly string[],
): ResultType<string, string> =>
	parseOptionalSingleArgument(args, z.string().min(2), "an");

const main = async (args: readonly string[]): Promise<number> => {
	const parsed = parseLiveArguments(args);
	if (parsed.isErr()) {
		const reported = writeStderr(
			`Usage: bun run live [search-term-of-at-least-two-characters]\n${parsed.error}\n`,
		);
		return reported.isErr() ? 1 : 2;
	}
	return runLive(parsed.value).match(
		(exit) => exit,
		(message) =>
			writeStderr(`${message}\n`)
				.map(() => 1)
				.unwrapOr(1),
	);
};

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
