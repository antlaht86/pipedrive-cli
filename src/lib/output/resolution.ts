import { ok } from "neverthrow";
import { z } from "zod";

import type { CacheStore } from "../cache/store.ts";
import type { PdWarning } from "../warnings.ts";
import {
	fieldSource,
	fixedSource,
	type CachedSource,
	type Entity,
} from "../pipedrive/cached.ts";
import type { PipedriveClient } from "../pipedrive/client.ts";
import type { Pages } from "../pipedrive/resources.ts";
import type { Page } from "../pipedrive/walk.ts";
import { relationOfFieldType } from "../pipedrive/relations.ts";
import type { NdjsonWriter } from "./ndjson-writer.ts";
import {
	createRelationResolution,
	type RelationLookups,
} from "./relation-resolution.ts";
import type { Projection } from "./projection.ts";

const HASH = /^[0-9a-f]{40}$/i;

const USER_FIELDS = ["owner_id", "creator_user_id", "user_id"] as const;
const STANDARD_PAIRS = [
	["owner_id", "owner_name", "users"],
	["creator_user_id", "creator_user_name", "users"],
	["user_id", "user_name", "users"],
	["person_id", "person_name", "persons"],
	["org_id", "org_name", "organizations"],
	["pipeline_id", "pipeline_name", "pipelines"],
	["stage_id", "stage_name", "stages"],
] as const;

type FixedLookupName = "users" | "pipelines" | "stages";
type LookupMaps = Partial<
	Record<FixedLookupName, ReadonlyMap<number, string>>
> &
	RelationLookups;

const Scalar = z.union([z.string(), z.number()]);
const ResolutionOption = z.object({ id: Scalar, label: z.string() });
const ResolutionField = z.object({
	field_code: z.string().regex(HASH),
	field_name: z.string(),
	field_type: z.string(),
	options: z.array(ResolutionOption).nullable().optional(),
});
type FieldSchema = z.infer<typeof ResolutionField>;

const NamedRecord = z.object({ id: z.int(), name: z.string() });
const OptionValue = z.union([Scalar, z.array(Scalar)]);
const MoneyValue = z.object({ value: Scalar, currency: z.string() });
const AddressValue = z.union([
	z.array(Scalar),
	z.record(z.string(), Scalar.nullish()),
]);

type ResolutionResource = {
	readonly name: string;
	readonly fields: readonly string[];
	readonly entity?: Entity;
};

type ResolutionContext = {
	resource: ResolutionResource;
	projection: Projection | undefined;
	client: PipedriveClient;
	store: CacheStore;
	noCache: boolean;
	writer: NdjsonWriter;
};

type CachedOwnerResolutionContext = Pick<
	ResolutionContext,
	"projection" | "store" | "noCache" | "writer"
> & { resource: string };

type Loaded = { records: Record<string, unknown>[]; source: CachedSource };

const parseAll = (
	source: CachedSource,
	raw: readonly unknown[],
): Record<string, unknown>[] | undefined => {
	const records: Record<string, unknown>[] = [];
	for (const value of raw) {
		const parsed = source.parse(value);
		if (parsed.isErr()) return undefined;
		records.push(parsed.value);
	}
	return records;
};

const idNameMap = (
	records: readonly Record<string, unknown>[],
): Map<number, string> => {
	const map = new Map<number, string>();
	for (const record of records) {
		const parsed = NamedRecord.safeParse(record);
		if (parsed.success) map.set(parsed.data.id, parsed.data.name);
	}
	return map;
};

const fieldMap = (
	records: readonly Record<string, unknown>[],
): Map<string, FieldSchema> => {
	const map = new Map<string, FieldSchema>();
	for (const record of records) {
		const parsed = ResolutionField.safeParse(record);
		if (parsed.success) map.set(parsed.data.field_code, parsed.data);
	}
	return map;
};

const optionIds = (
	value: unknown,
): { ids: string[]; array: boolean } | undefined => {
	const parsed = OptionValue.safeParse(value);
	if (!parsed.success) return undefined;
	if (Array.isArray(parsed.data)) {
		return { ids: parsed.data.map(String), array: true };
	}
	if (typeof parsed.data === "string" && parsed.data.includes(",")) {
		return { ids: parsed.data.split(",").map((id) => id.trim()), array: true };
	}
	return { ids: [String(parsed.data)], array: false };
};

const optionLabel = (
	schema: FieldSchema,
	value: unknown,
): string | string[] | undefined => {
	if (!Array.isArray(schema.options)) return undefined;
	const labels = new Map(
		schema.options.map((option) => [String(option.id), option.label]),
	);
	const values = optionIds(value);
	if (values === undefined) return undefined;
	const resolved = values.ids.map((id) => labels.get(id));
	if (resolved.some((label) => label === undefined)) return undefined;
	return values.array ? (resolved as string[]) : resolved[0];
};

const moneyLabel = (value: unknown): string | undefined => {
	const parsed = MoneyValue.safeParse(value);
	if (!parsed.success) return undefined;
	const { value: amount, currency } = parsed.data;
	if (typeof amount === "string" && amount !== "")
		return `${amount} ${currency}`;
	return typeof amount === "number" && Number.isFinite(amount)
		? `${amount.toFixed(2)} ${currency}`
		: undefined;
};

const addressLabel = (value: unknown): string | undefined => {
	const parsed = AddressValue.safeParse(value);
	if (!parsed.success) return undefined;
	const values = Array.isArray(parsed.data)
		? parsed.data
		: Object.values(parsed.data);
	const parts = values.filter(
		(part): part is string | number =>
			(typeof part === "string" && part !== "") || typeof part === "number",
	);
	return parts.length === 0 ? undefined : parts.join(", ");
};

const customLabel = (
	schema: FieldSchema,
	value: unknown,
	lookups: LookupMaps,
): string | string[] | undefined => {
	const id = z.int().safeParse(value);
	if (schema.field_type === "user") {
		return id.success ? lookups.users?.get(id.data) : undefined;
	}
	const relation = relationOfFieldType(schema.field_type);
	if (relation !== undefined) {
		return id.success ? lookups[relation].get(id.data) : undefined;
	}

	switch (schema.field_type) {
		case "enum":
		case "set":
			return optionLabel(schema, value);
		case "monetary":
			return moneyLabel(value);
		case "address":
			return addressLabel(value);
		default:
			return undefined;
	}
};

/** Search owner resolution is deliberately cache-only: the search request is the
 * only request the caller asked for, and `--resolve` must not add another one. */
export const createCachedOwnerResolution = ({
	resource,
	projection,
	store,
	noCache,
	writer,
}: CachedOwnerResolutionContext): ((pages: Pages) => Pages) => {
	if (projection?.includes("owner_id") === false) return (pages) => pages;

	const source = fixedSource("users");
	const read = noCache ? undefined : store.read(source.entry);
	if (read?.outcome === "skipped") writer.warn(read.warning);
	const records =
		read?.outcome === "hit" ? parseAll(source, read.records) : undefined;
	const users = records === undefined ? undefined : idNameMap(records);
	if (users === undefined) {
		writer.resolutionPartial();
		writer.warn({
			kind: "owner_resolution_unavailable",
			resource,
			message:
				"Could not read cached user metadata; owner ids are unresolved.",
		});
	}

	return async function* resolveOwners(pages: Pages): Pages {
		for await (const page of pages) {
			if (page.isErr()) {
				yield page;
				return;
			}
			yield ok({
				...page.value,
				records: page.value.records.map((record) => {
					const out: Record<string, unknown> = {};
					for (const [key, value] of Object.entries(record)) {
						out[key] = value;
						if (key !== "owner_id" || typeof value !== "number") continue;
						const name = users?.get(value);
						if (name !== undefined) out.owner_name = name;
					}
					return out;
				}),
			});
		}
	};
};

export const createResolution = async ({
	resource,
	projection,
	client,
	store,
	noCache,
	writer,
}: ResolutionContext): Promise<(pages: Pages) => Pages> => {
	let unavailableWarned = false;
	let unknownWarned = false;
	let refreshAttempted = false;

	const unavailable = (entry: string): void => {
		writer.resolutionPartial();
		if (unavailableWarned) return;
		unavailableWarned = true;
		writer.warn({
			kind: "owner_resolution_unavailable",
			resource: entry,
			message:
				"Could not fetch resolution metadata; affected ids are unresolved.",
		});
	};

	const fresh = async (source: CachedSource): Promise<Loaded | undefined> => {
		const fetched = await source.fetch(client);
		if (fetched.isErr()) {
			unavailable(source.entry);
			return undefined;
		}
		const warning = store.write(source.entry, fetched.value);
		if (warning !== undefined) writer.warn(warning);
		const records = parseAll(source, fetched.value);
		if (records === undefined) {
			unavailable(source.entry);
			return undefined;
		}
		return { records, source };
	};

	const load = async (source: CachedSource): Promise<Loaded | undefined> => {
		if (!noCache) {
			const read = store.read(source.entry);
			if (read.outcome === "skipped") writer.warn(read.warning);
			if (read.outcome === "hit") {
				const records = parseAll(source, read.records);
				if (records !== undefined) return { records, source };
			}
		}
		return fresh(source);
	};

	const selected = (field: string): boolean =>
		resource.fields.includes(field) && (projection?.includes(field) ?? true);
	const needsCustom = selected("custom_fields");
	const needsUsers = needsCustom || USER_FIELDS.some(selected);
	const needsPipelines = selected("pipeline_id");
	const needsStages = selected("stage_id");

	let schema =
		needsCustom && resource.entity !== undefined
			? await load(fieldSource(resource.entity))
			: undefined;
	const lookups: LookupMaps = {
		persons: new Map(),
		organizations: new Map(),
	};
	if (needsUsers) {
		const loaded = await load(fixedSource("users"));
		if (loaded !== undefined) lookups.users = idNameMap(loaded.records);
	}
	if (needsPipelines) {
		const loaded = await load(fixedSource("pipelines"));
		if (loaded !== undefined) lookups.pipelines = idNameMap(loaded.records);
	}
	if (needsStages) {
		const loaded = await load(fixedSource("stages"));
		if (loaded !== undefined) lookups.stages = idNameMap(loaded.records);
	}

	let fields =
		schema === undefined
			? new Map<string, FieldSchema>()
			: fieldMap(schema.records);
	const resolveRelations = createRelationResolution({
		client,
		writer,
		lookups,
		fields: () => fields,
		unavailable,
	});

	const refreshUnknown = async (): Promise<void> => {
		if (refreshAttempted || schema === undefined) return;
		refreshAttempted = true;
		if (resource.entity === undefined) return;
		schema = await fresh(fieldSource(resource.entity));
		fields = schema === undefined ? new Map() : fieldMap(schema.records);
	};

	const resolveRecord = (
		record: Record<string, unknown>,
	): Record<string, unknown> => {
		const custom = record.custom_fields;
		const resolved: Record<
			string,
			{ name: string; label?: string | string[] }
		> = {};
		if (
			custom !== null &&
			typeof custom === "object" &&
			!Array.isArray(custom)
		) {
			for (const [hash, value] of Object.entries(
				custom as Record<string, unknown>,
			)) {
				const definition = fields.get(hash);
				if (definition === undefined) continue;
				const label = customLabel(definition, value, lookups);
				resolved[hash] = {
					name: definition.field_name,
					...(label === undefined ? {} : { label }),
				};
			}
		}

		// Artifacts are inserted immediately after their raw field. The raw keys
		// retain their schema order while the additive sibling is literally beside
		// the id or block it explains.
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			out[key] = value;
			const pair = STANDARD_PAIRS.find(([raw]) => raw === key);
			if (pair !== undefined && typeof value === "number") {
				const name = lookups[pair[2]]?.get(value);
				if (name !== undefined) out[pair[1]] = name;
			}
			if (key === "custom_fields" && Object.keys(resolved).length > 0) {
				out.custom_fields_resolved = resolved;
			}
		}
		return out;
	};

	return async function* resolvePages(pages: Pages): Pages {
		for await (const page of pages) {
			if (page.isErr()) {
				yield page;
				return;
			}

			const unknown = new Set<string>();
			if (schema !== undefined) {
				for (const record of page.value.records) {
					const custom = record.custom_fields;
					if (
						custom === null ||
						typeof custom !== "object" ||
						Array.isArray(custom)
					)
						continue;
					for (const hash of Object.keys(custom)) {
						if (HASH.test(hash) && !fields.has(hash)) unknown.add(hash);
					}
				}
			}
			if (unknown.size > 0 && !refreshAttempted) await refreshUnknown();

			await resolveRelations(page.value.records);

			const surviving = [...unknown].filter((hash) => !fields.has(hash));
			const warnings: PdWarning[] = [...page.value.warnings];
			if (surviving.length > 0) {
				writer.resolutionPartial();
				if (!unknownWarned) {
					unknownWarned = true;
					warnings.push({
						kind: "unknown_custom_field",
						resource: resource.name,
						message: `${surviving.length} field key${surviving.length === 1 ? " is" : "s are"} not in the schema; emitted raw.`,
					});
				}
			}

			yield ok({
				...page.value,
				warnings,
				records: page.value.records.map(resolveRecord),
			} as Page<Record<string, unknown>>);
		}
	};
};
