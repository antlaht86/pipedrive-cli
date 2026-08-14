/**
 * `pd <resource> list` and `pd <resource> get <id>` — one command for all five
 * live resources.
 *
 * This is ticket 05's `deals-list.ts` with the resource lifted into a parameter
 * and the second verb added. Argument parsing, credential resolution, the walk
 * or the by-id fetch, two-stage validation, the writer, the error union and the
 * exit codes are shared by construction rather than by five files agreeing.
 *
 * What is left here is the middle: which flags this verb takes, and whether the
 * run is a cursor walk or a by-id fetch. Everything before that — the parse,
 * the gate, the writer, the credential and the trailer every failure among them
 * still ends in — is `prologue.ts`, shared with the cached resources.
 *
 * ## Injected seams, and nothing else
 *
 * `transport`, `clock` and `sink` are parameters, on exactly the reasoning
 * ADR-0019 §4 used for the clock. There is no test-only flag and no test-only
 * environment variable (ADR-0019 §5); production passes `globalThis.fetch`, the
 * system clock and `process.stdout.write` explicitly.
 */

import { ok } from "neverthrow";

import { createCacheStore } from "../lib/cache/store.ts";
import { parseListFilters } from "../lib/pipedrive/list-filters.ts";
import type { Resource } from "../lib/pipedrive/resources.ts";
import { createProjection, projectPages } from "../lib/output/projection.ts";
import { createResolution } from "../lib/output/resolution.ts";
import { stream } from "../lib/output/stream.ts";
import type { Flag } from "./arguments.ts";
import { begin, type CommandInput, type Verb } from "./prologue.ts";

export type { Verb };

export type ResourceCommandInput = CommandInput & {
	resource: Resource;
	verb: Verb;
};

/**
 * ADR-0003: `--limit` **does not exist on non-list commands**, so passing it to
 * `pd deals get 42` is a usage error rather than a silent no-op. It is left out
 * of the flag list for that verb, which makes the refusal `parseArgs`'s
 * unknown-option path and keeps one wording for every flag a command lacks.
 *
 * `--max-requests` is on both. ADR-0003 scopes only the bound to list commands,
 * and ADR-0010 §3 defines the guard over the requests a run makes — `get` is a
 * run, and a `get` under a spent ceiling is the same refusal for the same
 * reason. Ticket 16's manifest documents the flag under both verbs.
 *
 * `--no-cache` is absent from both: these five resources are never cached
 * (ADR-0005 §1), and a flag that does nothing is a flag an agent spends a turn
 * discovering does nothing. Ticket 11 adds it here, when `--resolve` gives it
 * something to skip.
 *
 * The names are bare, and the `--` is added where a name is printed. They are
 * typed as flags of the shared schema, so the list and the schema cannot drift
 * apart: a flag `parseArgs` would accept and the schema would not validate is a
 * compile error rather than a value that reaches the walk unchecked.
 */
const LIST_FLAGS: readonly Flag[] = [
	"token-file",
	"limit",
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"fields",
];

const GET_FLAGS: readonly Flag[] = [
	"token-file",
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"fields",
];

export const resourceCommand = async ({
	resource,
	verb,
	...input
}: ResourceCommandInput): Promise<number> => {
	const started = begin({
		...input,
		command: `pd ${resource.name} ${verb}`,
		flags:
			verb === "list" ? [...LIST_FLAGS, ...resource.filterFlags] : GET_FLAGS,
		positional: verb === "get" ? "integer-id" : "none",
		recordType: resource.recordType,
		rename: resource.rename,
		// Selector names come from the local zod schema, so a typo is refused
		// before credential resolution or dispatch.
		resolve: (flags) =>
			createProjection(flags.fields, resource.fields, resource.rename).andThen(
				(projection) =>
					verb === "list"
						? parseListFilters(resource, flags).map((filters) => ({
								projection,
								filters,
							}))
						: ok({ projection, filters: {} }),
			),
	});
	if (started.isErr()) return started.error;

	const {
		parsed,
		resolved: { projection, filters },
		writer,
		client,
		credential,
		clock,
	} = started.value;

	const store = createCacheStore({
		platform: input.platform,
		env: input.env,
		home: input.home,
		fingerprint: credential.fingerprint,
		clock,
	});

	// `integer-id` above is what makes this a number; the shared parser also
	// serves `pd fields get <field_code>`, whose id is a string.
	const id = parsed.id;
	const projected = projectPages(
		typeof id === "number"
			? resource.get(client, id, projection)
			: resource.list(client, parsed.flags.limit, projection, filters),
		projection,
	);
	const pages =
		parsed.flags.resolve === true
			? (
					await createResolution({
						resource,
						projection,
						client,
						store,
						noCache: parsed.flags["no-cache"] === true,
						writer,
					})
				)(projected)
			: projected;
	return stream(pages, writer);
};
