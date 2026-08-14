import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { Arguments, Flag } from "../../commands/arguments.ts";
import { pdError, type PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import type { Pages } from "./resources.ts";
import { LIST_PAGE_SIZE, walk } from "./walk.ts";
import {
	searchDeals,
	searchOrganization,
	searchPersons,
	searchProducts,
} from "./v2/generated/sdk.gen.ts";
import type {
	SearchDealsData,
	SearchOrganizationData,
	SearchPersonsData,
	SearchProductsData,
} from "./v2/generated/types.gen.ts";

const IdName = z.object({ id: z.int(), name: z.string() }).strict();
const Owner = z.object({ id: z.int() }).strict();

const DealHit = z
	.object({
		result_score: z.number(),
		item: z
			.object({
				id: z.int(),
				type: z.string(),
				title: z.string(),
				value: z.int(),
				currency: z.string(),
				status: z.string(),
				visible_to: z.int(),
				owner: Owner,
				stage: IdName,
				person: IdName.nullable(),
				organization: IdName.nullable(),
				custom_fields: z.array(z.string()),
				notes: z.array(z.string()),
				is_archived: z.boolean(),
			})
			.strict(),
	})
	.strict()
	.transform(({ result_score, item }) => ({
		id: item.id,
		title: item.title,
		value: item.value,
		currency: item.currency,
		status: item.status,
		visible_to: item.visible_to,
		owner_id: item.owner.id,
		stage_id: item.stage.id,
		stage_name: item.stage.name,
		...(item.person === null
			? {}
			: { person_id: item.person.id, person_name: item.person.name }),
		...(item.organization === null
			? {}
			: {
					org_id: item.organization.id,
					org_name: item.organization.name,
				}),
		matched_custom_field_values: item.custom_fields,
		matched_notes: item.notes,
		is_archived: item.is_archived,
		result_score,
	}));

const PersonHit = z
	.object({
		result_score: z.number(),
		item: z
			.object({
				id: z.int(),
				type: z.string(),
				name: z.string(),
				phones: z.array(z.string()),
				emails: z.array(z.string()),
				visible_to: z.int(),
				owner: Owner,
				organization: IdName,
				custom_fields: z.array(z.string()),
				notes: z.array(z.string()),
			})
			.strict(),
	})
	.strict()
	.transform(({ result_score, item }) => ({
		id: item.id,
		name: item.name,
		phones: item.phones,
		emails: item.emails,
		visible_to: item.visible_to,
		owner_id: item.owner.id,
		org_id: item.organization.id,
		org_name: item.organization.name,
		matched_custom_field_values: item.custom_fields,
		matched_notes: item.notes,
		result_score,
	}));

const OrganizationHit = z
	.object({
		result_score: z.number(),
		item: z
			.object({
				id: z.int(),
				type: z.string(),
				name: z.string(),
				address: z.string(),
				visible_to: z.int(),
				owner: Owner,
				custom_fields: z.array(z.string()),
				notes: z.array(z.string()),
			})
			.strict(),
	})
	.strict()
	.transform(({ result_score, item }) => ({
		id: item.id,
		name: item.name,
		address: item.address,
		visible_to: item.visible_to,
		owner_id: item.owner.id,
		matched_custom_field_values: item.custom_fields,
		matched_notes: item.notes,
		result_score,
	}));

const ProductHit = z
	.object({
		result_score: z.number(),
		item: z
			.object({
				id: z.int(),
				type: z.string(),
				name: z.string(),
				code: z.int(),
				visible_to: z.int(),
				owner: Owner,
				custom_fields: z.array(z.string()),
			})
			.strict(),
	})
	.strict()
	.transform(({ result_score, item }) => ({
		id: item.id,
		name: item.name,
		code: item.code,
		visible_to: item.visible_to,
		owner_id: item.owner.id,
		matched_custom_field_values: item.custom_fields,
		result_score,
	}));

const SearchEnvelopeItems = z.looseObject({
	data: z.object({ items: z.array(z.unknown()) }),
});

const flattenEnvelope = (body: unknown): unknown => {
	const parsed = SearchEnvelopeItems.safeParse(body);
	if (!parsed.success) return body;
	const { data, ...envelope } = parsed.data;
	return { ...envelope, data: data.items };
};

export type SearchOptions = {
	readonly exact: boolean;
	readonly searchIn?: string;
	readonly personId?: number;
	readonly organizationId?: number;
	readonly status?: "open" | "won" | "lost";
};

type SearchCall = (
	client: PipedriveClient,
	term: string,
	cursor: string | undefined,
	options: SearchOptions,
) => ReturnType<PipedriveClient["v2"]>;

export type Search = {
	readonly recordType: string;
	readonly fields: readonly string[];
	readonly searchIn: readonly string[];
	readonly flags: readonly Flag[];
	readonly run: (
		client: PipedriveClient,
		term: string,
		limit: number | undefined,
		options: SearchOptions,
	) => Pages;
};

const query = (
	term: string,
	cursor: string | undefined,
	options: SearchOptions,
) => ({
	term,
	limit: LIST_PAGE_SIZE,
	...(cursor === undefined ? {} : { cursor }),
	...(options.exact ? { exact_match: true } : {}),
});

const defineSearch = <T extends Record<string, unknown> & { id: number }>({
	recordType,
	fields,
	searchIn,
	flags,
	record,
	call,
}: Omit<Search, "run"> & {
	record: z.ZodType<T, unknown>;
	call: SearchCall;
}): Search => ({
	recordType,
	fields,
	searchIn,
	flags,
	run: (client, term, limit, options) =>
		walk({
			resource: recordType,
			record,
			keyOf: (hit) => `${recordType}:${hit.id}`,
			fetchPage: (cursor) =>
				call(client, term, cursor, options).map(flattenEnvelope),
			...(limit === undefined ? {} : { limit }),
		}),
});

const BASE_FLAGS = [
	"token-file",
	"limit",
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"fields",
	"exact",
	"search-in",
] as const satisfies readonly Flag[];

const SEARCHES = new Map<string, Search>([
	[
		"deals",
		defineSearch({
			recordType: "deal_search_hit",
			fields: [
				"id",
				"title",
				"value",
				"currency",
				"status",
				"visible_to",
				"owner_id",
				"stage_id",
				"stage_name",
				"person_id",
				"person_name",
				"org_id",
				"org_name",
				"matched_custom_field_values",
				"matched_notes",
				"is_archived",
				"result_score",
			],
			searchIn: ["custom_fields", "notes", "title"],
			flags: [...BASE_FLAGS, "person-id", "organization-id", "status"],
			record: DealHit,
			call: (client, term, cursor, options) =>
				client.v2(searchDeals, {
					query: {
						...query(term, cursor, options),
						fields: options.searchIn as SearchDealsData["query"]["fields"],
						...(options.personId === undefined
							? {}
							: { person_id: options.personId }),
						...(options.organizationId === undefined
							? {}
							: { organization_id: options.organizationId }),
						...(options.status === undefined ? {} : { status: options.status }),
					},
				}),
		}),
	],
	[
		"persons",
		defineSearch({
			recordType: "person_search_hit",
			fields: [
				"id",
				"name",
				"phones",
				"emails",
				"visible_to",
				"owner_id",
				"org_id",
				"org_name",
				"matched_custom_field_values",
				"matched_notes",
				"result_score",
			],
			searchIn: ["custom_fields", "email", "name", "notes", "phone"],
			flags: [...BASE_FLAGS, "organization-id"],
			record: PersonHit,
			call: (client, term, cursor, options) =>
				client.v2(searchPersons, {
					query: {
						...query(term, cursor, options),
						fields: options.searchIn as SearchPersonsData["query"]["fields"],
						...(options.organizationId === undefined
							? {}
							: { organization_id: options.organizationId }),
					},
				}),
		}),
	],
	[
		"organizations",
		defineSearch({
			recordType: "organization_search_hit",
			fields: [
				"id",
				"name",
				"address",
				"visible_to",
				"owner_id",
				"matched_custom_field_values",
				"matched_notes",
				"result_score",
			],
			searchIn: ["address", "custom_fields", "name", "notes"],
			flags: BASE_FLAGS,
			record: OrganizationHit,
			call: (client, term, cursor, options) =>
				client.v2(searchOrganization, {
					query: {
						...query(term, cursor, options),
						fields:
							options.searchIn as SearchOrganizationData["query"]["fields"],
					},
				}),
		}),
	],
	[
		"products",
		defineSearch({
			recordType: "product_search_hit",
			fields: [
				"id",
				"name",
				"code",
				"visible_to",
				"owner_id",
				"matched_custom_field_values",
				"result_score",
			],
			searchIn: ["code", "custom_fields", "name"],
			flags: BASE_FLAGS,
			record: ProductHit,
			call: (client, term, cursor, options) =>
				client.v2(searchProducts, {
					query: {
						...query(term, cursor, options),
						fields: options.searchIn as SearchProductsData["query"]["fields"],
					},
				}),
		}),
	],
]);

const csv = (value: string): string[] => value.split(",");

export const parseSearchOptions = (
	search: Search,
	term: string,
	flags: Arguments,
): Result<SearchOptions, PdError> => {
	if ([...term].length < (flags.exact === true ? 1 : 2)) {
		return err(
			pdError({
				code: "usage",
				message: "A search term needs at least two characters, or one with --exact.",
			}),
		);
	}

	const selected = flags["search-in"] === undefined ? undefined : csv(flags["search-in"]);
	const invalid = selected?.find(
		(field) => field === "" || !search.searchIn.includes(field),
	);
	if (invalid !== undefined) {
		return err(
			pdError({
				code: "usage",
				message:
					`--search-in cannot search '${invalid}'. It takes one or more of: ` +
					`${search.searchIn.join(", ")}.`,
			}),
		);
	}

	if (flags.status === "deleted") {
		return err(
			pdError({
				code: "usage",
				message: "--status on search takes one of: open, won, lost.",
			}),
		);
	}

	return ok({
		exact: flags.exact === true,
		...(selected === undefined ? {} : { searchIn: selected.join(",") }),
		...(flags["person-id"] === undefined
			? {}
			: { personId: flags["person-id"] }),
		...(flags["organization-id"] === undefined
			? {}
			: { organizationId: flags["organization-id"] }),
		...(flags.status === undefined ? {} : { status: flags.status }),
	});
};

export const searchNamed = (name: string): Search | undefined =>
	SEARCHES.get(name);
