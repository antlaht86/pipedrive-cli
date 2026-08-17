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
import { identifiedBy, integerId, type FieldVocabulary } from "./schema.ts";
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
	/** Top-level names in this source's field vocabulary, in output order. */
	readonly fields: readonly string[];
	/** `field_code` for fields, `id` for every other cached resource. */
	readonly identityField: string;
	/**
	 * ADR-0006 §2's second stage, one record at a time — narrowed by ADR-0029 §5
	 * to "does this record carry an identity", except on `users`, whose interior
	 * `pd` reads.
	 */
	readonly parse: (raw: unknown) => Result<Record<string, unknown>, z.ZodError>;
	/** Every record, all pages, exactly as Pipedrive returned them. */
	readonly fetch: (
		client: PipedriveClient,
	) => PromiseLike<Result<unknown[], PdError>>;
};

type CachedListFilter = {
	readonly flag: "pipeline-id";
	readonly apply: (
		records: readonly Record<string, unknown>[],
		value: number,
	) => Record<string, unknown>[];
};

export type CachedResource = {
	/** The plural noun on the command line — ADR-0009 §5, Pipedrive's own. */
	readonly name: string;
	/** ADR-0009: singular, the `record_type` on every emitted line. */
	readonly recordType: string;
	/** True for `fields` alone: `--entity` exists, and it is required. */
	readonly needsEntity: boolean;
	/** Optional command-scoped filter over the cached whole list. */
	readonly listFilter?: CachedListFilter;
	/**
	 * The entity is present exactly when `needsEntity` is true, and `undefined`
	 * comes back when it is not — which the command answers with the `usage`
	 * refusal below rather than with a throw.
	 */
	readonly source: (entity?: Entity) => CachedSource | undefined;
};

type SourceDefinition = {
	entry: CacheEntryName;
	/** ADR-0029 §3: read for its field names, and not used to gate a record. */
	vocabulary: FieldVocabulary;
	/**
	 * The gate, where it asks more than `key` does. Present on `users` alone:
	 * ADR-0029 §2 keeps the schemas `pd` reads the interior of, and `UserRecord`
	 * is one `pd` wrote itself from an observed response.
	 */
	gate?: z.ZodType<Record<string, unknown>, unknown>;
	identityField?: string;
	key: (raw: unknown) => string | number | undefined;
	fetch: (client: PipedriveClient) => PromiseLike<Result<unknown[], PdError>>;
};

const defineSource = ({
	entry,
	vocabulary,
	gate,
	identityField = "id",
	key,
	fetch,
}: SourceDefinition): CachedSource => {
	const admits = gate ?? identifiedBy(key);
	return {
		entry,
		fields: Object.keys(vocabulary.shape),
		identityField,
		key,
		fetch,
		parse: (raw) => {
			const parsed = admits.safeParse(raw);
			return parsed.success ? ok(parsed.data) : err(parsed.error);
		},
	};
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
 * A whole v2 list behind one generated operation. Six of the eight entries are
 * exactly this and differ only in their operation, their record schema and
 * their key, so they are one factory rather than six copies of a cursor loop
 * with one of them subtly wrong.
 */
const v2Source = (
	entry: CacheEntryName,
	vocabulary: FieldVocabulary,
	operation: Parameters<PipedriveClient["v2"]>[0],
	key: (raw: unknown) => string | number | undefined,
	identityField?: string,
): CachedSource =>
	defineSource({
		entry,
		vocabulary,
		...(identityField === undefined ? {} : { identityField }),
		key,
		fetch: collectPages(
			(cursor) => (client) =>
				client.v2(operation, { query: listQuery(cursor) }),
		),
	});

/** Every field source has the same string identity; only its schema and endpoint vary. */
const v2FieldSource = (
	entry: CacheEntryName,
	vocabulary: FieldVocabulary,
	operation: Parameters<PipedriveClient["v2"]>[0],
): CachedSource => v2Source(entry, vocabulary, operation, codeKey, "field_code");

/**
 * The five `*Fields` responses carry no response `title`, so the hoist in
 * `openapi-ts.config.ts` left them inline and there is no `zGetDealFieldsItem`
 * to import. The element schema is taken from the generated array instead of
 * being hand-written: a field record is forty-odd `field_type` values deep, and
 * a transcription of it would be a second opinion about the same spec that
 * drifts silently on the next regeneration.
 */
const FIELD_SOURCES: Record<Entity, CachedSource> = {
	deal: v2FieldSource(
		"dealFields",
		zGetDealFieldsResponse.shape.data.element,
		getDealFields,
	),
	person: v2FieldSource(
		"personFields",
		zGetPersonFieldsResponse.shape.data.element,
		getPersonFields,
	),
	organization: v2FieldSource(
		"organizationFields",
		zGetOrganizationFieldsResponse.shape.data.element,
		getOrganizationFields,
	),
	product: v2FieldSource(
		"productFields",
		zGetProductFieldsResponse.shape.data.element,
		getProductFields,
	),
	activity: v2FieldSource(
		"activityFields",
		zGetActivityFieldsResponse.shape.data.element,
		getActivityFields,
	),
};

/** Sources shared by their own commands and ADR-0008's fixed-cost resolver. */
const FIXED_SOURCES = {
	users: defineSource({
		entry: "users",
		vocabulary: UserRecord,
		gate: UserRecord,
		key: integerId,
		fetch: fetchUsers,
	}),
	pipelines: v2Source("pipelines", zGetPipelinesItem, getPipelines, integerId),
	stages: v2Source("stages", zGetStagesItem, getStages, integerId),
} as const;

export type FixedSourceName = keyof typeof FIXED_SOURCES;

export const fixedSource = (name: FixedSourceName): CachedSource =>
	FIXED_SOURCES[name];

export const fieldSource = (entity: Entity): CachedSource =>
	FIELD_SOURCES[entity];

/** A resource with one source: the entity a `fields` command passes is ignored. */
const only = (source: CachedSource) => (): CachedSource => source;

const CACHED: readonly CachedResource[] = [
	{
		name: "users",
		recordType: "user",
		needsEntity: false,
		source: only(FIXED_SOURCES.users),
	},
	{
		name: "pipelines",
		recordType: "pipeline",
		needsEntity: false,
		source: only(FIXED_SOURCES.pipelines),
	},
	{
		name: "stages",
		recordType: "stage",
		needsEntity: false,
		listFilter: {
			flag: "pipeline-id",
			apply: (records, pipelineId) =>
				records.filter((record) => record["pipeline_id"] === pipelineId),
		},
		source: only(FIXED_SOURCES.stages),
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
export const cachedResourceNamed = (name: string): CachedResource | undefined =>
	BY_NAME.get(name);

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
