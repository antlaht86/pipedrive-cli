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

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { err, ok, Result } from "neverthrow";
import { z } from "zod";

import { pdError } from "../src/lib/errors.ts";
import { PdFailure } from "../src/lib/pipedrive/failure.ts";
import type { Transport } from "../src/lib/pipedrive/guarded-fetch.ts";
import { route } from "../src/router.ts";
import {
	fixtureDocument,
	type RecordedFixture,
} from "./release-gates.ts";

const parseJson = Result.fromThrowable(JSON.parse, (cause) => String(cause));
const parseUrl = (value: string): Result<URL, string> => {
	const parsed = URL.parse(value);
	return parsed === null ? err("unparseable URL") : ok(parsed);
};
const JsonBody = z.json();

const failure = (
	message: string,
	code: "internal" | "upstream" | "write_blocked" | "request_ceiling",
) => new PdFailure(pdError({ code, message }));

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
				failure("The live recorder refused a non-GET request.", "write_blocked"),
			);
		}
		if (requests >= maxRequests) {
			return Promise.reject(
				failure("The live recorder reached its request ceiling.", "request_ceiling"),
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
						const url = parseUrl(request.url);
						if (url.isErr()) {
							return Promise.reject(
								failure(
									`The live recorder received an invalid URL: ${url.error}`,
									"internal",
								),
							);
						}
						recorded.push({
							method: "GET",
							path: url.value.pathname,
							query: Object.fromEntries(url.value.searchParams),
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
const FIELD_ENTITIES = ["deal", "person", "organization", "activity", "product"];

const commands = (term: string): string[][] => [
	...LISTS.map((resource) => [resource, "list", "--limit", "20"]),
	...CACHED.map((resource) => [resource, "list"]),
	...FIELD_ENTITIES.map((entity) => ["fields", "list", "--entity", entity]),
	...SEARCHES.map((resource) => [resource, "search", term, "--limit", "20"]),
];

const runLive = async (term: string): Promise<number> => {
	const workspace = mkdtempSync(join(tmpdir(), "pd-live-"));
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

	for (const argv of commands(term)) {
		const exit = await route({
			argv: [...argv, "--max-requests", String(MAX_REQUESTS)],
			platform: process.platform,
			env,
			home: homedir(),
			transport,
			sink: () => undefined,
			stderr: (text) => process.stderr.write(text),
			isTty: () => false,
		});
		if (exit !== 0) {
			rmSync(workspace, { recursive: true, force: true });
			return exit;
		}
	}

	await Bun.write(
		FIXTURE_PATH,
		`${JSON.stringify(fixtureDocument(recorded), null, 2)}\n`,
	);
	rmSync(workspace, { recursive: true, force: true });
	process.stdout.write(`re-recorded ${recorded.length} responses in ${FIXTURE_PATH}\n`);
	const diff = Bun.spawnSync(["git", "diff", "--", FIXTURE_PATH]);
	process.stdout.write(diff.stdout);
	process.stderr.write(diff.stderr);
	return diff.exitCode;
};

if (import.meta.main) {
	const parsed = z.string().min(2).safeParse(process.argv[2] ?? "an");
	if (!parsed.success) {
		process.stderr.write("Usage: bun run live [search-term-of-at-least-two-characters]\n");
		process.exitCode = 2;
	} else process.exitCode = await runLive(parsed.data);
}
