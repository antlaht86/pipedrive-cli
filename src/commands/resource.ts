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

import { commandNamed } from "../command-table.ts";
import { createCacheStore } from "../lib/cache/store.ts";
import { pdError } from "../lib/errors.ts";
import { parseListFilters } from "../lib/pipedrive/list-filters.ts";
import type { Pages, Resource } from "../lib/pipedrive/resources.ts";
import {
	parseSearchOptions,
	type Search,
} from "../lib/pipedrive/searches.ts";
import { createProjection, projectPages } from "../lib/output/projection.ts";
import {
	createCachedOwnerResolution,
	createResolution,
} from "../lib/output/resolution.ts";
import { stream } from "../lib/output/stream.ts";
import type { Positional } from "./arguments.ts";
import { begin, type CommandInput, type Verb } from "./prologue.ts";

export type { Verb };

export type ResourceCommandInput = CommandInput &
	(
		| { resource: Resource; verb: Exclude<Verb, "search"> }
		| { search: Search; name: string; verb: "search" }
	);

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
export const resourceCommand = async (
	input: ResourceCommandInput,
): Promise<number> => {
	const { verb } = input;
	const search = verb === "search" ? input.search : undefined;
	const resource = verb === "search" ? undefined : input.resource;
	const name = verb === "search" ? input.name : input.resource.name;
	const definition = commandNamed(`pd ${name} ${verb}`);
	const flags = definition?.parserFlags ?? [];
	let positional: Positional = "none";
	if (verb === "get") positional = "integer-id";
	if (verb === "search") positional = "search-term";

	const started = begin({
		...input,
		command: `pd ${name} ${verb}`,
		flags,
		positional,
		recordType: search?.recordType ?? resource?.recordType ?? name,
		mixedRecordTypes: search?.mixedRecordTypes,
		rename: verb === "search" ? {} : resource?.rename,
		// Selector names come from the local zod schema, so a typo is refused
		// before credential resolution or dispatch.
		resolve: (flags, parsed) => {
			const schemaFields = search?.fields ?? resource?.fields ?? [];
			const rename = search === undefined ? (resource?.rename ?? {}) : {};
			return createProjection(flags.fields, schemaFields, rename).andThen(
				(projection) => {
					if (verb === "list" && resource !== undefined) {
						return parseListFilters(resource, flags).map((filters) => ({
							projection,
							filters,
							searchOptions: undefined,
						}));
					}
					if (verb === "search" && search !== undefined) {
						return parseSearchOptions(search, parsed.term ?? "", flags).map(
							(searchOptions) => ({
								projection,
								filters: {},
								searchOptions,
							}),
						);
					}
					return ok({ projection, filters: {}, searchOptions: undefined });
				},
			);
		},
	});
	if (started.isErr()) return started.error;

	const {
		parsed,
		resolved: { projection, filters, searchOptions },
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
	let source: Pages;
	if (search !== undefined && searchOptions !== undefined) {
		source = search.run(
			client,
			parsed.term ?? "",
			parsed.flags.limit,
			searchOptions,
		);
	} else if (verb === "get" && typeof id === "number") {
		source = input.resource.get(client, id, projection);
	} else if (verb === "list") {
		source = input.resource.list(
			client,
			parsed.flags.limit,
			projection,
			filters,
		);
	} else {
		return writer.error(
			pdError({
				code: "internal",
				message: "A search command did not produce search options.",
			}),
		);
	}
	const projected = projectPages(source, projection);
	if (parsed.flags.resolve !== true) return stream(projected, writer);

	if (verb === "search") {
		const pages = createCachedOwnerResolution({
			resource: search?.recordType ?? name,
			projection,
			store,
			noCache: parsed.flags["no-cache"] === true,
			writer,
		})(projected);
		return stream(pages, writer);
	}

	const resolve = await createResolution({
		resource: input.resource,
		projection,
		client,
		store,
		noCache: parsed.flags["no-cache"] === true,
		writer,
	});
	return stream(resolve(projected), writer);
};
