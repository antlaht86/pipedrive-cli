import type { Flag } from "./commands/arguments.ts";
import { ERROR_CODES, exitCodeFor, retryFor } from "./lib/errors.ts";
import { WARNING_KINDS } from "./lib/warnings.ts";
import {
	ENTITIES,
	cachedResourceNamed,
	type Entity,
} from "./lib/pipedrive/cached.ts";
import { LIVE_RESOURCES, resourceNamed } from "./lib/pipedrive/resources.ts";
import { searchNamed } from "./lib/pipedrive/searches.ts";

export const MANIFEST_VERSION = 1;

const GLOBAL_DATA_FLAGS = [
	"token-file",
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"fields",
] as const satisfies readonly Flag[];

const LIST_DATA_FLAGS = [
	"token-file",
	"limit",
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"fields",
] as const satisfies readonly Flag[];

const FLAG_NAMES: Record<Flag, string> = {
	"token-file": "--token-file <path>",
	limit: "--limit <n>",
	"max-requests": "--max-requests <n>",
	"resolve-budget": "--resolve-budget <n>",
	"no-cache": "--no-cache",
	resolve: "--resolve",
	exact: "--exact",
	"search-in": "--search-in <a,b>",
	types: "--types <a,b>",
	"organization-id": "--organization-id <n>",
	entity: "--entity <name>",
	fields: "--fields <a,b>",
	ids: "--ids <a,b>",
	"owner-id": "--owner-id <n>",
	"person-id": "--person-id <n>",
	"org-id": "--org-id <n>",
	"deal-id": "--deal-id <n>",
	"pipeline-id": "--pipeline-id <n>",
	"stage-id": "--stage-id <n>",
	"filter-id": "--filter-id <n>",
	status: "--status <name>",
	done: "--done",
	"not-done": "--not-done",
	"updated-since": "--updated-since <timestamp>",
	"updated-until": "--updated-until <timestamp>",
	"sort-by": "--sort-by <field>",
	"sort-direction": "--sort-direction <asc|desc>",
};

type CommandArgument = {
	readonly name: string;
	readonly required: boolean;
	readonly values?: readonly string[];
};

export type CommandDefinition = {
	readonly name: string;
	readonly description: string;
	readonly arguments: readonly CommandArgument[];
	readonly flags: readonly string[];
	readonly delivery: "streams" | "collects";
	readonly selectable_fields?: readonly string[];
	readonly selectable_fields_by_entity?: Readonly<Record<Entity, readonly string[]>>;
	/** Internal parser names; omitted from the emitted manifest. */
	readonly parserFlags: readonly Flag[];
};

type ResourceDefinition = {
	readonly name: string;
	readonly description: string;
	readonly commands: readonly CommandDefinition[];
};

type OtherDefinition = {
	readonly name: string;
	readonly description: string;
	readonly arguments: readonly CommandArgument[];
	readonly flags: readonly string[];
	readonly delivery: "streams" | "collects";
};

export type CommandTable = {
	readonly resources: readonly ResourceDefinition[];
	readonly other: readonly OtherDefinition[];
};

const outputFields = (
	fields: readonly string[],
	rename: Readonly<Record<string, string>> = {},
): readonly string[] => fields.map((field) => rename[field] ?? field);

const command = ({
	name,
	description,
	arguments: args = [],
	parserFlags,
	selectableFields,
	selectableFieldsByEntity,
}: {
	name: string;
	description: string;
	arguments?: readonly CommandArgument[];
	parserFlags: readonly Flag[];
	selectableFields?: readonly string[];
	selectableFieldsByEntity?: Readonly<Record<Entity, readonly string[]>>;
}): CommandDefinition => ({
	name,
	description,
	arguments: args,
	flags: parserFlags.map((flag) => FLAG_NAMES[flag]),
	delivery: "streams",
	...(selectableFields === undefined
		? {}
		: { selectable_fields: selectableFields }),
	...(selectableFieldsByEntity === undefined
		? {}
		: { selectable_fields_by_entity: selectableFieldsByEntity }),
	parserFlags,
});

const dataCommands = (name: string): readonly CommandDefinition[] => {
	const live = resourceNamed(name);
	const cached = cachedResourceNamed(name);
	const search = searchNamed(name);
	const commands: CommandDefinition[] = [];

	if (live !== undefined) {
		const selectable = outputFields(live.fields, live.rename);
		commands.push(
			command({
				name: `pd ${name} list`,
				description: `List ${name}; fetches the complete result unless --limit is given.`,
				parserFlags: [...LIST_DATA_FLAGS, ...live.filterFlags],
				selectableFields: selectable,
			}),
			command({
				name: `pd ${name} get`,
				description: `Get one ${live.recordType} by id.`,
				arguments: [{ name: "id", required: true }],
				parserFlags: GLOBAL_DATA_FLAGS,
				selectableFields: selectable,
			}),
		);
	}

	if (cached !== undefined) {
		const entityFlags = cached.needsEntity ? (["entity"] as const) : [];
		const listFilter = cached.listFilter?.flag;
		const common = [...GLOBAL_DATA_FLAGS, ...entityFlags] as const;
		const source = cached.source();
		const byEntity = cached.needsEntity
			? Object.fromEntries(
					ENTITIES.map((entity) => [
						entity,
						cached.source(entity)?.fields ?? [],
					]),
				) as Record<Entity, readonly string[]>
			: undefined;
		const args: readonly CommandArgument[] = cached.needsEntity
			? [{ name: "--entity", required: true, values: ENTITIES }]
			: [];
		commands.push(
			command({
				name: `pd ${name} list`,
				description: `List cached ${name}.`,
				arguments: args,
				parserFlags: [
					...LIST_DATA_FLAGS,
					...entityFlags,
					...(listFilter === undefined ? [] : [listFilter]),
				],
				selectableFields: source?.fields,
				selectableFieldsByEntity: byEntity,
			}),
			command({
				name: `pd ${name} get`,
				description: `Get one cached ${cached.recordType}.`,
				arguments: [
					{ name: cached.needsEntity ? "field_code" : "id", required: true },
					...args,
				],
				parserFlags: common,
				selectableFields: source?.fields,
				selectableFieldsByEntity: byEntity,
			}),
		);
	}

	if (search !== undefined) {
		commands.push(
			command({
				name: `pd ${name} search`,
				description: `Search ${name}; a bounded search returns the best matches.`,
				arguments: [{ name: "term", required: true }],
				parserFlags: search.flags,
				selectableFields: search.fields,
			}),
		);
	}

	return commands;
};

const RESOURCE_NAMES = [
	...LIVE_RESOURCES,
	"pipelines",
	"stages",
	"users",
	"fields",
	"items",
] as const;

export const COMMAND_TABLE: CommandTable = {
	resources: RESOURCE_NAMES.map((name) => ({
		name,
		description:
			name === "items"
				? "Search across deals, persons, organizations and products."
				: `Read Pipedrive ${name}.`,
		commands: dataCommands(name),
	})),
	other: [
		{
			name: "pd manifest",
			description: "Emit the complete machine-readable command contract as one JSON object.",
			arguments: [],
			flags: [],
			delivery: "collects",
		},
		{
			name: "pd cache info",
			description: "Describe local cache entries and blocked sentinels.",
			arguments: [],
			flags: [],
			delivery: "collects",
		},
		{
			name: "pd cache clear",
			description: "Delete local cache entries while preserving blocked sentinels.",
			arguments: [],
			flags: [],
			delivery: "collects",
		},
		{
			name: "pd auth status",
			description: "Report credential discovery without making a request.",
			arguments: [],
			flags: ["--token-file <path>"],
			delivery: "collects",
		},
		{
			name: "pd docs",
			description: "Emit the AGENTS.md documentation embedded in this binary.",
			arguments: [],
			flags: [],
			delivery: "collects",
		},
	],
};

export const commandNamed = (
	name: string,
	table: CommandTable = COMMAND_TABLE,
): CommandDefinition | undefined =>
	table.resources
		.flatMap((resource) => resource.commands)
		.find((candidate) => candidate.name === name);

const GLOBAL_FLAGS = [
	{
		name: "--pretty",
		applies_to: "data commands and supported single-object commands",
		machine_readable: false,
		instruction: "Never invoke --pretty from an agent; it emits unstable human-readable output.",
	},
	{ name: "--no-cache", applies_to: "data commands" },
	{ name: "--max-requests <n>", applies_to: "data commands" },
	{ name: "--limit <n>", applies_to: "list and search commands" },
	{ name: "--resolve", applies_to: "data commands" },
	{ name: "--resolve-budget <n>", applies_to: "data commands" },
	{ name: "--token-file <path>", applies_to: "data commands and pd auth status" },
	{ name: "--verbose", applies_to: "data commands" },
	{ name: "--fields <a,b>", applies_to: "data commands" },
] as const;

const COMMAND_FLAGS = [
	{ name: "--ids <a,b>", enumerable: true },
	{ name: "--owner-id <n>", enumerable: true },
	{ name: "--person-id <n>", enumerable: true },
	{ name: "--org-id <n>", enumerable: true },
	{ name: "--organization-id <n>", enumerable: true },
	{ name: "--deal-id <n>", enumerable: true },
	{ name: "--pipeline-id <n>", enumerable: true },
	{ name: "--stage-id <n>", enumerable: true },
	{ name: "--filter-id <n>", enumerable: false },
	{ name: "--status <name>", enumerable: true },
	{ name: "--done", enumerable: true },
	{ name: "--not-done", enumerable: true },
	{ name: "--updated-since <timestamp>", enumerable: true },
	{ name: "--updated-until <timestamp>", enumerable: true },
	{ name: "--sort-by <field>", enumerable: true },
	{ name: "--sort-direction <asc|desc>", enumerable: true },
	{ name: "--entity <name>", enumerable: true },
	{ name: "--exact", enumerable: true },
	{ name: "--search-in <a,b>", enumerable: true },
	{ name: "--types <a,b>", enumerable: true },
] as const;

const manifestCommand = (definition: CommandDefinition) => ({
	name: definition.name,
	description: definition.description,
	arguments: definition.arguments,
	flags: definition.flags,
	delivery: definition.delivery,
	...(definition.selectable_fields === undefined
		? {}
		: { selectable_fields: definition.selectable_fields }),
	...(definition.selectable_fields_by_entity === undefined
		? {}
		: {
				selectable_fields_by_entity:
					definition.selectable_fields_by_entity,
			}),
});

export const createManifest = (
	pdVersion: string,
	table: CommandTable = COMMAND_TABLE,
) => ({
	manifest_version: MANIFEST_VERSION,
	pd_version: pdVersion,
	read_only: true as const,
	read_only_scope: "pipedrive_api" as const,
	output_format: "ndjson" as const,
	non_ndjson_stdout: [
		"--help",
		"pd manifest",
		"pd auth status",
		"pd cache info",
		"pd docs",
		"pd --version",
	],
	commands: {
		resources: table.resources.map((resource) => ({
			...resource,
			commands: resource.commands.map(manifestCommand),
		})),
		other: table.other,
	},
	global_flags: GLOBAL_FLAGS,
	command_flags: COMMAND_FLAGS,
	vocabularies: {
		line_types: ["record", "warning", "summary", "error"] as const,
		warning_kinds: WARNING_KINDS,
		resolved: ["off", "partial", "full"] as const,
		exit_codes: [0, 1, 2, 3] as const,
		error_codes: ERROR_CODES.map((code) => ({
			code,
			exit_code: exitCodeFor(code),
			retry: retryFor(code),
		})),
	},
	trailer_fields: [
		"complete",
		"emitted",
		"skipped",
		"duplicates",
		"resolved",
		"requests",
	] as const,
});

const section = (title: string, rows: readonly { name: string; description: string }[]): string =>
	`${title}\n${rows.map((row) => `  ${row.name.replace(/^pd /, "")}\n      ${row.description}`).join("\n")}`;

const selectableFieldsHelp = (
	definition: CommandDefinition | OtherDefinition,
): string => {
	if (
		"selectable_fields" in definition &&
		definition.selectable_fields !== undefined
	) {
		return `\n\nSELECTABLE FIELDS\n  ${definition.selectable_fields.join(", ")}`;
	}
	if (
		!("selectable_fields_by_entity" in definition) ||
		definition.selectable_fields_by_entity === undefined
	) {
		return "";
	}
	return `\n\nSELECTABLE FIELDS BY --ENTITY\n${ENTITIES.map(
		(entity) =>
			`  ${entity}: ${definition.selectable_fields_by_entity?.[entity].join(", ") ?? ""}`,
	).join("\n")}`;
};

const commandHelp = (definition: CommandDefinition | OtherDefinition): string => {
	const positional = definition.arguments
		.flatMap((argument) =>
			argument.name.startsWith("--") ? [] : [`<${argument.name}>`],
		)
		.join(" ");
	const usage = `${definition.name}${positional === "" ? "" : ` ${positional}`}${definition.flags.length === 0 ? "" : " [flags]"}`;
	const flags = definition.flags.length === 0 ? "" : `\n\nFLAGS\n${definition.flags.map((flag) => `  ${flag}`).join("\n")}`;
	return `USAGE\n  ${usage}\n\n${definition.description}${flags}${selectableFieldsHelp(definition)}\n`;
};

export const renderHelp = (
	argv: readonly string[],
	table: CommandTable = COMMAND_TABLE,
): string => {
	const words = argv.filter((arg) => arg !== "--help");
	if (words.length === 0) {
		return (
			"pd is read-only. It issues GET requests only. It cannot create, update or delete anything in Pipedrive.\n" +
			"API tokens can authorise writes; pd's code refuses them. Use a restricted Pipedrive permission set for account-level protection.\n\n" +
			"USAGE\n  pd <resource> <verb> [argument] [flags]\n\n" +
			section("RESOURCES", table.resources) +
			"\n\n" +
			section("OTHER", table.other) +
			"\n"
		);
	}

	const exact = `pd ${words.join(" ")}`;
	const data = commandNamed(exact, table);
	if (data !== undefined) return commandHelp(data);
	const other = table.other.find((candidate) => candidate.name === exact);
	if (other !== undefined) return commandHelp(other);

	if (words.length === 1) {
		const resource = table.resources.find((candidate) => candidate.name === words[0]);
		if (resource !== undefined) {
			return `${resource.description}\n\n${section("COMMANDS", resource.commands)}\n`;
		}
		const prefix = `pd ${words[0]} `;
		const grouped = table.other.filter((candidate) => candidate.name.startsWith(prefix));
		if (grouped.length > 0) return `${section("COMMANDS", grouped)}\n`;
	}

	return "";
};
