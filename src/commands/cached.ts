/**
 * `pd users|pipelines|stages|fields list` and their `get` — the four cached
 * resources of ADR-0005 §1, ADR-0007 and ADR-0009 §3.
 *
 * `resource.ts` is the same command for the five live resources, and everything
 * the two share is shared: the argument parser, the credential chain, the
 * writer, the error union and the exit codes. What differs is the middle, and
 * only the middle — where a live resource walks a cursor and yields pages, a
 * cached resource loads **one array of raw records**, from disk when the entry
 * is live and from Pipedrive when it is not.
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

import { pdError, type PdError } from "../lib/errors.ts";
import { resolveCredential } from "../lib/auth/credentials.ts";
import { createCacheStore, type CacheStore } from "../lib/cache/store.ts";
import { systemClock, type Clock } from "../lib/pipedrive/clock.ts";
import { createGuardedFetch } from "../lib/pipedrive/guarded-fetch.ts";
import type { Transport } from "../lib/pipedrive/guarded-fetch.ts";
import { createPipedriveClient } from "../lib/pipedrive/client.ts";
import {
  entityRefusal,
  isEntity,
  type CachedResource,
  type CachedSource,
  type Entity,
} from "../lib/pipedrive/cached.ts";
import { rejectedRecord } from "../lib/pipedrive/single.ts";
import { noSurvivors, rejection, type Bound, type Page } from "../lib/pipedrive/walk.ts";
import { NdjsonWriter, type Sink } from "../lib/output/ndjson-writer.ts";
import { stream } from "../lib/output/stream.ts";
import {
  TOKEN_REFUSAL,
  parseArguments,
  refusesToken,
  type Flag,
} from "./arguments.ts";
import type { Verb } from "./resource.ts";

export type CachedCommandInput = {
  resource: CachedResource;
  verb: Verb;
  /** Everything after `pd <resource> <verb>`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  transport?: Transport;
  clock?: Clock;
  sink?: Sink;
  stderr?: Sink;
};

/**
 * `--no-cache` is on both verbs, because both read the cache. `--entity` is
 * appended for `fields` alone and is required there (ADR-0009 §4); on any other
 * cached resource it is an unknown flag, which is the same refusal every flag a
 * command lacks receives.
 */
const flagsFor = (verb: Verb, needsEntity: boolean): readonly Flag[] => [
  "token-file",
  ...(verb === "list" ? (["limit"] as const) : []),
  "max-requests",
  "no-cache",
  ...(needsEntity ? (["entity"] as const) : []),
];

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
  argv,
  platform,
  env,
  home,
  transport,
  clock = systemClock,
  sink,
  stderr,
}: CachedCommandInput): Promise<number> => {
  const command = `pd ${resource.name} ${verb}`;

  // Parsing is pure and comes first, because the two things built below take
  // their configuration from it: the gate needs `--max-requests` before its
  // first request, and the writer needs to know whether the run is bounded
  // before its first record. A parse failure is still reported through the
  // writer, so the trailer invariant holds either way.
  const refused = refusesToken(argv);
  const parsed = parseArguments({
    command,
    flags: flagsFor(verb, resource.needsEntity),
    positional:
      verb === "get"
        ? resource.needsEntity
          ? "code-id"
          : "integer-id"
        : "none",
    argv,
  });
  const flags = parsed.isOk() ? parsed.value.flags : undefined;

  const guarded = createGuardedFetch({
    ...(transport === undefined ? {} : { transport }),
    clock,
    ...(flags?.["max-requests"] === undefined
      ? {}
      : { maxRequests: flags["max-requests"] }),
  });

  const writer = new NdjsonWriter({
    recordType: resource.recordType,
    requests: guarded.dispatches,
    // ADR-0003: the stderr size warning is for an **unbounded** run. A caller
    // who passed `--limit` has already said how much output it wants.
    bounded: flags?.limit !== undefined,
    ...(sink === undefined ? {} : { sink }),
    ...(stderr === undefined ? {} : { stderr }),
  });

  // Before the parse failure, and deliberately: `--token abc` tokenises as an
  // unknown flag, and answering it with the generic refusal would drop the one
  // sentence that says where a token may come from instead.
  if (refused) return writer.error(TOKEN_REFUSAL);
  if (parsed.isErr()) return writer.error(parsed.error);

  const given = parsed.value.flags.entity;
  const entity: Entity | undefined =
    given !== undefined && isEntity(given) ? given : undefined;
  const source = resource.source(entity);
  if (source === undefined) return writer.error(entityRefusal(command, given));

  const credential = resolveCredential({
    platform,
    env,
    home,
    ...(parsed.value.flags["token-file"] === undefined
      ? {}
      : { tokenFile: parsed.value.flags["token-file"] }),
  });
  if (credential.isErr()) return writer.error(credential.error);

  // ADR-0012 §3 and ADR-0021 §8: a credentials file the rest of the machine can
  // read is a `warning`, not a refusal. It rides the stream like any other.
  for (const warning of credential.value.warnings) writer.warn(warning);

  const client = createPipedriveClient({
    token: credential.value.token,
    guarded,
  });

  const store: CacheStore = createCacheStore({
    platform,
    env,
    home,
    fingerprint: credential.value.fingerprint,
    clock,
  });

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
    if (parsed.value.flags["no-cache"] === true) return fetchFresh();

    const read = store.read(source.entry);
    if (read.outcome === "skipped") writer.warn(read.warning);
    return read.outcome === "hit"
      ? ok({ records: read.records, fromCache: true })
      : fetchFresh();
  };

  const loaded = await load();
  if (loaded.isErr()) return writer.error(loaded.error);

  const id = parsed.value.id;

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
    }

    // ADR-0006 §4, as `walk.ts` applies it to a first page: zero survivors out
    // of one or more records means the schema does not describe this resource
    // at all, and it fires before any `record` line is written.
    if (checked.rejected > 0 && checked.records.length === 0) {
      return writer.error(noSurvivors(resource.recordType, checked.rejected));
    }

    return stream(onePage(bounded(checked.page, flags?.limit)), writer);
  }

  // ADR-0007 §4, generalised by ADR-0009 §3: `get` filters the list. The probe
  // reads the id out of an unvalidated record, because only the record that
  // matches is the answer — validating the whole list here would emit
  // `record_rejected` warnings about rows the caller never asked for.
  const find = (records: readonly unknown[]): unknown | undefined =>
    records.find((record) => source.key(record) === id);

  let match = find(loaded.value.records);

  // ADR-0005 §3's unrecognised-key refresh: an id absent from a *cached* list is
  // one re-fetch regardless of TTL, so a user who joined this morning is found
  // and a deleted one is still reported missing.
  if (match === undefined && loaded.value.fromCache) {
    const fresh = await fetchFresh();
    if (fresh.isErr()) return writer.error(fresh.error);
    match = find(fresh.value.records);
  }

  if (match === undefined) return writer.error(notFound(resource, id));

  const record = source.parse(match);
  if (record.isErr()) {
    return writer.error(
      rejectedRecord(resource.recordType, id, record.error),
    );
  }

  return stream(
    onePage({ records: [record.value], warnings: [], duplicates: 0 }),
    writer,
  );
};
