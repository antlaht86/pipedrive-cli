/**
 * `pd users|pipelines|stages|fields list` and their `get` — the four cached
 * resources of ADR-0005 §1, ADR-0007 and ADR-0009 §3.
 *
 * `resource.ts` is the same command for the five live resources, and everything
 * the two share is shared through `prologue.ts`: the argument parser, the gate,
 * the writer, the credential chain, the error union and the exit codes. What
 * differs is the middle, and only the middle — where a live resource walks a
 * cursor and yields pages, a cached resource loads **one array of raw records**,
 * from disk when the entry is live and from Pipedrive when it is not.
 *
 * ## The disk cannot change what `pd` accepts
 *
 * A cache entry holds the records exactly as they arrived, and validation runs
 * on the way *out* rather than on the way in. So a warm run and a cold run put
 * the same records through the same schema, produce the same `record_rejected`
 * warnings and the same `skipped` count, and `--no-cache` changes the request
 * count and nothing else. The corollary is the one non-obvious branch here:
 * when a warm entry yields no survivors at all, that is read as a stale
 * *schema* rather than as a broken resource, so the entry is refetched. The
 * version stamp cannot catch that case — it stamps the file format, not the
 * generated zod schemas.
 *
 * ## Nothing about the cache is ever fatal
 *
 * A corrupt entry, an unwritable directory, a rename that failed: each is one
 * `cache_entry_skipped` warning and a refetch (ADR-0005 §5, §8). The `users`
 * *fetch* failing is fatal here, and deliberately — under `--resolve` the same
 * failure will degrade to raw ids, because there the user list decorates an
 * answer, while here it **is** the answer (ADR-0007 §8).
 */

import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";

import { commandNamed } from "../command-table.ts";
import { pdError, type PdError } from "../lib/errors.ts";
import { createCacheStore, type CacheStore } from "../lib/cache/store.ts";
import {
	entityRefusal,
	isEntity,
	type CachedResource,
	type CachedSource,
	type Entity,
} from "../lib/pipedrive/cached.ts";
import { rejectedRecord } from "../lib/pipedrive/single.ts";
import {
	noSurvivors,
	rejection,
	type Bound,
	type Page,
} from "../lib/pipedrive/walk.ts";
import { createProjection, projectPages } from "../lib/output/projection.ts";
import { createResolution } from "../lib/output/resolution.ts";
import { stream } from "../lib/output/stream.ts";
import type { Pages } from "../lib/pipedrive/resources.ts";
import { begin, type CommandInput, type Verb } from "./prologue.ts";

export type CachedCommandInput = CommandInput & {
	resource: CachedResource;
	verb: Verb;
};

/**
 * `--no-cache` is on both verbs, because both read the cache. `--entity` is
 * appended for `fields` alone and is required there (ADR-0009 §4); on any other
 * cached resource it is an unknown flag, which is the same refusal every flag a
 * command lacks receives.
 */
/**
 * The `--entity` value as the table understands it. An unknown spelling becomes
 * `undefined`, which is the same answer a missing flag gives — and the same
 * refusal, because `pd fields list --entity lead` and `pd fields list` are one
 * mistake with one correction.
 */
const entityOf = (given: string | undefined): Entity | undefined =>
	given !== undefined && isEntity(given) ? given : undefined;

const positionalFor = (
	verb: Verb,
	resource: CachedResource,
): "none" | "integer-id" | "code-id" => {
	if (verb === "list") return "none";
	return resource.needsEntity ? "code-id" : "integer-id";
};

/** The whole list, and where it came from. */
type Loaded = { records: readonly unknown[]; fromCache: boolean };

/**
 * ADR-0006 §2's second stage over a whole list, with the walk's own rejection
 * warnings and the walk's own deduplication. `duplicates` is structurally zero
 * on all four resources and is still counted, because the alternative is a
 * counter that means something different here than it does on a list command.
 */
type Validated = {
	records: Record<string, unknown>[];
	page: Page<Record<string, unknown>>;
	/** Raw records the record schema refused, before deduplication. */
	rejected: number;
};

const validate = (
	resource: CachedResource,
	source: CachedSource,
	raw: readonly unknown[],
): Validated => {
	const records: Record<string, unknown>[] = [];
	const warnings = [];
	const seen = new Set<string | number>();
	let rejected = 0;
	let duplicates = 0;

	for (const value of raw) {
		const parsed = source.parse(value);
		if (parsed.isErr()) {
			rejected += 1;
			warnings.push(rejection(resource.recordType, value, parsed.error));
			continue;
		}
		const key = source.key(parsed.value);
		if (key !== undefined && seen.has(key)) {
			duplicates += 1;
			continue;
		}
		if (key !== undefined) seen.add(key);
		records.push(parsed.value);
	}

	return { records, rejected, page: { records, warnings, duplicates } };
};

/**
 * ADR-0003 §1 over a list that is already whole. There is no cursor to be
 * uncertain about: a limit below the record count truncates and the trailer says
 * `complete: false`, and a limit at or above it is a complete answer.
 */
const bounded = (
	page: Page<Record<string, unknown>>,
	limit: number | undefined,
): Page<Record<string, unknown>> =>
	limit === undefined || page.records.length <= limit
		? page
		: {
				...page,
				records: page.records.slice(0, limit),
				bound: "limit" as Bound,
			};

/** `stream()` consumes a generator, and one page is still a generator. */
async function* onePage(
	page: Page<Record<string, unknown>>,
): AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>> {
	yield ok(page);
}

const notFound = (resource: CachedResource, id: string | number): PdError =>
	pdError({
		code: "not_found",
		message: `Pipedrive has no ${resource.recordType} with id ${id}.`,
		details: { resource: resource.recordType, id },
	});

export const cachedCommand = async ({
	resource,
	verb,
	...input
}: CachedCommandInput): Promise<number> => {
	const command = `pd ${resource.name} ${verb}`;

	// The entity is checked inside the prologue's own offline step, so a missing
	// `--entity` is a usage error on a machine with no credential at all.
	const started = begin({
		...input,
		command,
		flags: commandNamed(`pd ${resource.name} ${verb}`)?.parserFlags ?? [],
		positional: positionalFor(verb, resource),
		recordType: resource.recordType,
		resolve: (flags) => {
			const source = resource.source(entityOf(flags.entity));
			if (source === undefined)
				return err(entityRefusal(command, flags.entity));
			return createProjection(
				flags.fields,
				source.fields,
				{},
				source.identityField,
			).map((projection) => ({ source, projection }));
		},
	});
	if (started.isErr()) return started.error;

	const {
		parsed,
		resolved: { source, projection },
		writer,
		client,
		credential,
		clock,
	} = started.value;
	const flags = parsed.flags;

	const store: CacheStore = createCacheStore({
		platform: input.platform,
		env: input.env,
		home: input.home,
		fingerprint: credential.fingerprint,
		clock,
	});

	const withResolution = async (pages: Pages): Promise<Pages> =>
		flags.resolve === true
			? (
					await createResolution({
						resource: { name: resource.name, fields: source.fields },
						projection,
						client,
						store,
						noCache: flags["no-cache"] === true,
						writer,
					})
				)(pages)
			: pages;

	/**
	 * ADR-0005 §8: the fresh answer replaces the cached entry even when the read
	 * was skipped by `--no-cache`, so one run restores the normal path. A fetch
	 * that failed is never written — half a list is not an entry.
	 */
	const fetchFresh = async (): Promise<Result<Loaded, PdError>> => {
		const fetched = await source.fetch(client);
		if (fetched.isErr()) return err(fetched.error);
		const failure = store.write(source.entry, fetched.value);
		if (failure !== undefined) writer.warn(failure);
		return ok({ records: fetched.value, fromCache: false });
	};

	const load = async (): Promise<Result<Loaded, PdError>> => {
		if (flags["no-cache"] === true) return fetchFresh();

		const read = store.read(source.entry);
		if (read.outcome === "skipped") writer.warn(read.warning);
		return read.outcome === "hit"
			? ok({ records: read.records, fromCache: true })
			: fetchFresh();
	};

	const loaded = await load();
	if (loaded.isErr()) return writer.error(loaded.error);

	const id = parsed.id;

	if (id === undefined) {
		const { records, fromCache } = loaded.value;
		let checked = validate(resource, source, records);

		// A warm entry every record of which fails validation is a schema that has
		// moved on since the entry was written. It is refetched rather than
		// reported, which is what keeps a warm run and a cold run equivalent.
		if (fromCache && records.length > 0 && checked.records.length === 0) {
			const fresh = await fetchFresh();
			if (fresh.isErr()) return writer.error(fresh.error);
			checked = validate(resource, source, fresh.value.records);
		} else if (fromCache) {
			// Ticket 25, and this is why the report waits until here rather than
			// firing where the entry was read: the branch above answers a hit with a
			// request, and "no request" would already have been written by then.
			writer.cacheServed(source.entry);
		}

		// ADR-0006 §4, as `walk.ts` applies it to a first page and ADR-0029 §5
		// narrowed it: zero survivors out of one or more records means not one
		// carried an identity `pd` can read, and it fires before any `record` line
		// is written.
		if (checked.rejected > 0 && checked.records.length === 0) {
			return writer.error(noSurvivors(resource.recordType, checked.rejected));
		}

		let filtered = checked.page;
		const listFilter = resource.listFilter;
		if (listFilter !== undefined) {
			const value = flags[listFilter.flag];
			if (typeof value === "number") {
				filtered = {
					...checked.page,
					records: listFilter.apply(checked.page.records, value),
				};
			}
		}

		return stream(
			await withResolution(
				projectPages(onePage(bounded(filtered, flags.limit)), projection),
			),
			writer,
		);
	}

	// ADR-0007 §4, generalised by ADR-0009 §3: `get` filters the list. The probe
	// reads the id out of an unvalidated record, because only the record that
	// matches is the answer — validating the whole list here would emit
	// `record_rejected` warnings about rows the caller never asked for.
	const find = (records: readonly unknown[]): unknown | undefined =>
		records.find((record) => source.key(record) === id);

	const matched = (
		records: readonly unknown[],
	): Result<Record<string, unknown>, z.ZodError> | undefined => {
		const found = find(records);
		return found === undefined ? undefined : source.parse(found);
	};

	let record = matched(loaded.value.records);

	// Two reasons to spend one re-fetch on a warm entry, and they are the same
	// reason: what is on disk is behind. ADR-0005 §3's unrecognised-key refresh
	// covers the id that is simply absent — a user who joined this morning is
	// found, and a deleted one is still reported missing. A record that no longer
	// parses covers the other half, and is the `get` half of the list path's
	// no-survivors branch above: the version stamp cannot see a regenerated
	// schema, so a warm `get` would otherwise fail where the same `get` on a cold
	// cache succeeds.
	if (loaded.value.fromCache && (record === undefined || record.isErr())) {
		const fresh = await fetchFresh();
		if (fresh.isErr()) return writer.error(fresh.error);
		record = matched(fresh.value.records);
	} else if (loaded.value.fromCache) {
		// Ticket 25, deferred for the same reason as the list path above: a warm
		// `get` that does not find its id spends a request after all.
		writer.cacheServed(source.entry);
	}

	if (record === undefined) return writer.error(notFound(resource, id));
	if (record.isErr()) {
		return writer.error(rejectedRecord(resource.recordType, id, record.error));
	}

	return stream(
		await withResolution(
			projectPages(
				onePage({ records: [record.value], warnings: [], duplicates: 0 }),
				projection,
			),
		),
		writer,
	);
};
