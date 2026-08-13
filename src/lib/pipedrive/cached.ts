/**
 * The four cached resources — ADR-0005 §1, ADR-0007, ADR-0009 §2–§4.
 *
 * `resources.ts` is the live table: five resources that fetch on every
 * invocation, each a cursor walk. This is the other half. `users`, `pipelines`,
 * `stages` and `fields` are near-static, are read far more often than they
 * change, and cost the shared company budget every time they are fetched — so
 * they are fetched **whole**, cached under the credential, and served from disk
 * until their TTL expires.
 *
 * Three differences from the live table follow from that, and nothing else does:
 *
 * - **A source produces raw records, not pages.** The disk holds what the wire
 *   held (see `cache/store.ts`), so the fetch collects every page's `data`
 *   elements unvalidated and hands the array over. Validation happens once, in
 *   the command, on the same array whether it came from Pipedrive or from disk.
 * - **Identity is read from a raw record.** `get` filters the cached list before
 *   anything is validated, so the key function parses an id out of an unchecked
 *   value the way ADR-0006 §6 recovers an id for a rejected record's warning.
 * - **`fields` is five sources behind one noun.** `--entity` selects one, and
 *   ADR-0009 §4 makes it required: defaulting to all five makes the heaviest
 *   output the default, which an agent reaches for precisely when it does not
 *   yet know what to ask.
 *
 * `projectFields` is deliberately absent: ADR-0009 §2 gave projects no command
 * surface, so the closed list stays at eight entries.
 */

import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { CacheEntryName } from "../cache/entries.ts";
import type { PipedriveClient } from "./client.ts";
import { ListEnvelope, nextCursorOf } from "./envelope.ts";
import { LIST_PAGE_SIZE, structural } from "./walk.ts";
import { UserRecord, fetchUsers } from "./users.ts";
import {
  getActivityFields,
  getDealFields,
  getOrganizationFields,
  getPersonFields,
  getPipelines,
  getProductFields,
  getStages,
} from "./v2/generated/sdk.gen.ts";
import {
  zGetActivityFieldsResponse,
  zGetDealFieldsResponse,
  zGetOrganizationFieldsResponse,
  zGetPersonFieldsResponse,
  zGetPipelinesItem,
  zGetProductFieldsResponse,
  zGetStagesItem,
} from "./v2/generated/zod.gen.ts";

/** ADR-0009 §4: the permitted values of `--entity`, and there are no others. */
export const ENTITIES = [
  "deal",
  "person",
  "organization",
  "product",
  "activity",
] as const;

export type Entity = (typeof ENTITIES)[number];

export type CachedSource = {
  /** Which of the eight cache entries this source fills. */
  readonly entry: CacheEntryName;
  /** The identity of an **unvalidated** record; `undefined` when unrecoverable. */
  readonly key: (raw: unknown) => string | number | undefined;
  /** ADR-0006 §2's second stage, one record at a time. */
  readonly parse: (raw: unknown) => Result<Record<string, unknown>, z.ZodError>;
  /** Every record, all pages, exactly as Pipedrive returned them. */
  readonly fetch: (
    client: PipedriveClient,
  ) => PromiseLike<Result<unknown[], PdError>>;
};

export type CachedResource = {
  /** The plural noun on the command line — ADR-0009 §5, Pipedrive's own. */
  readonly name: string;
  /** ADR-0009: singular, the `record_type` on every emitted line. */
  readonly recordType: string;
  /** True for `fields` alone: `--entity` exists, and it is required. */
  readonly needsEntity: boolean;
  /**
   * The entity is present exactly when `needsEntity` is true, and `undefined`
   * comes back when it is not — which the command answers with the `usage`
   * refusal below rather than with a throw.
   */
  readonly source: (entity?: Entity) => CachedSource | undefined;
};

type SourceDefinition<T extends Record<string, unknown>> = {
  entry: CacheEntryName;
  record: z.ZodType<T, unknown>;
  key: (raw: unknown) => string | number | undefined;
  fetch: (client: PipedriveClient) => PromiseLike<Result<unknown[], PdError>>;
};

/**
 * The one place a concrete record type is known. `T` is constrained to an open
 * record, so the widening on the way out needs no cast and the four sources can
 * hold four different record shapes in one table.
 */
const defineSource = <T extends Record<string, unknown>>({
  entry,
  record,
  key,
  fetch,
}: SourceDefinition<T>): CachedSource => ({
  entry,
  key,
  fetch,
  parse: (raw) => {
    const parsed = record.safeParse(raw);
    return parsed.success ? ok(parsed.data) : err(parsed.error);
  },
});

/**
 * An id read out of a value nothing has validated yet. It is deliberately
 * narrow: anything that is not an object with the right primitive under the
 * right key is "no key", and a record with no key can never be matched by
 * `get` — which is the correct answer for a record the schema would reject too.
 */
const numberKey = (raw: unknown): number | undefined => {
  const value = (raw as Record<string, unknown> | null)?.["id"];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const codeKey = (raw: unknown): string | undefined => {
  const value = (raw as Record<string, unknown> | null)?.["field_code"];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * A whole v2 list, every page of it, unvalidated. The cursor loop is written
 * here rather than reused from `walk.ts` because the two want opposite things:
 * the walk streams pages so a 40,000-record answer never sits in memory, and
 * this collects because the cache entry *is* the whole list. Neither retries,
 * counts or backs off — that is all below, in `guardedFetch`.
 */
type PageCall = (
  cursor: string | undefined,
) => (client: PipedriveClient) => ReturnType<PipedriveClient["v2"]>;

const collectPages =
  (page: PageCall) =>
  async (client: PipedriveClient): Promise<Result<unknown[], PdError>> => {
    const records: unknown[] = [];
    let cursor: string | undefined;

    for (;;) {
      const body = await page(cursor)(client);
      if (body.isErr()) return err(body.error);

      const envelope = ListEnvelope.safeParse(body.value);
      if (!envelope.success) {
        return err(
          structural(
            "Pipedrive returned a list body pd cannot read. Retrying will not help.",
            envelope.error,
          ),
        );
      }

      records.push(...envelope.data.data);
      cursor = nextCursorOf(envelope.data);
      if (cursor === undefined) return ok(records);
    }
  };

/** The cursor query every v2 list takes — the same one `resources.ts` sends. */
const listQuery = (
  cursor: string | undefined,
): { limit: number; cursor?: string } => ({
  limit: LIST_PAGE_SIZE,
  ...(cursor === undefined ? {} : { cursor }),
});

/**
 * The five `*Fields` responses carry no response `title`, so the hoist in
 * `openapi-ts.config.ts` left them inline and there is no `zGetDealFieldsItem`
 * to import. The element schema is taken from the generated array instead of
 * being hand-written: a field record is forty-odd `field_type` values deep, and
 * a transcription of it would be a second opinion about the same spec that
 * drifts silently on the next regeneration.
 */
const FIELD_SOURCES: Record<Entity, CachedSource> = {
  deal: defineSource({
    entry: "dealFields",
    record: zGetDealFieldsResponse.shape.data.element,
    key: codeKey,
    fetch: collectPages(
      (cursor) => (client) =>
        client.v2(getDealFields, { query: listQuery(cursor) }),
    ),
  }),
  person: defineSource({
    entry: "personFields",
    record: zGetPersonFieldsResponse.shape.data.element,
    key: codeKey,
    fetch: collectPages(
      (cursor) => (client) =>
        client.v2(getPersonFields, { query: listQuery(cursor) }),
    ),
  }),
  organization: defineSource({
    entry: "organizationFields",
    record: zGetOrganizationFieldsResponse.shape.data.element,
    key: codeKey,
    fetch: collectPages(
      (cursor) => (client) =>
        client.v2(getOrganizationFields, { query: listQuery(cursor) }),
    ),
  }),
  product: defineSource({
    entry: "productFields",
    record: zGetProductFieldsResponse.shape.data.element,
    key: codeKey,
    fetch: collectPages(
      (cursor) => (client) =>
        client.v2(getProductFields, { query: listQuery(cursor) }),
    ),
  }),
  activity: defineSource({
    entry: "activityFields",
    record: zGetActivityFieldsResponse.shape.data.element,
    key: codeKey,
    fetch: collectPages(
      (cursor) => (client) =>
        client.v2(getActivityFields, { query: listQuery(cursor) }),
    ),
  }),
};

const single = (source: CachedSource) => (): CachedSource => source;

const CACHED: readonly CachedResource[] = [
  {
    name: "users",
    recordType: "user",
    needsEntity: false,
    source: single(
      defineSource({
        entry: "users",
        record: UserRecord,
        key: numberKey,
        fetch: fetchUsers,
      }),
    ),
  },
  {
    name: "pipelines",
    recordType: "pipeline",
    needsEntity: false,
    source: single(
      defineSource({
        entry: "pipelines",
        record: zGetPipelinesItem,
        key: numberKey,
        fetch: collectPages(
          (cursor) => (client) =>
            client.v2(getPipelines, { query: listQuery(cursor) }),
        ),
      }),
    ),
  },
  {
    name: "stages",
    recordType: "stage",
    needsEntity: false,
    source: single(
      defineSource({
        entry: "stages",
        record: zGetStagesItem,
        key: numberKey,
        fetch: collectPages(
          (cursor) => (client) =>
            client.v2(getStages, { query: listQuery(cursor) }),
        ),
      }),
    ),
  },
  {
    name: "fields",
    recordType: "field",
    needsEntity: true,
    source: (entity) =>
      entity === undefined ? undefined : FIELD_SOURCES[entity],
  },
];

/** Every cached resource, in the order `--help` and the manifest will list them. */
export const CACHED_RESOURCES: readonly string[] = CACHED.map(
  (resource) => resource.name,
);

const BY_NAME = new Map(CACHED.map((resource) => [resource.name, resource]));

/** ADR-0009 §5: exact match, no aliases, no synonyms. */
export const cachedResourceNamed = (
  name: string,
): CachedResource | undefined => BY_NAME.get(name);

export const isEntity = (value: string): value is Entity =>
  (ENTITIES as readonly string[]).includes(value);

/** The `usage` refusal ADR-0009 §4 requires when `--entity` is missing or wrong. */
export const entityRefusal = (command: string, given?: string): PdError =>
  pdError({
    code: "usage",
    message:
      (given === undefined
        ? `${command} requires --entity. `
        : `${command} does not have an entity '${given}'. `) +
      `--entity takes one of: ${ENTITIES.join(", ")}.`,
    details: { ...(given === undefined ? {} : { entity: given }) },
  });
