import type { Flag } from "./commands/arguments.ts";
import { ERROR_CODES, exitCodeFor, retryFor } from "./lib/errors.ts";
import { DEAL_STATUSES } from "./lib/pipedrive/list-filters.ts";
import { WARNING_KINDS } from "./lib/warnings.ts";
import {
	ENTITIES,
	cachedResourceNamed,
	type Entity,
} from "./lib/pipedrive/cached.ts";
import { LIVE_RESOURCES, resourceNamed } from "./lib/pipedrive/resources.ts";
import { searchNamed } from "./lib/pipedrive/searches.ts";

export const MANIFEST_VERSION = 1;

type FlagDefinition = {
	readonly parser?: Flag;
	readonly name: string;
	readonly group: "global" | "command";
	readonly applies_to?: string;
	readonly enumerable?: boolean;
	readonly machine_readable?: boolean;
	readonly instruction?: string;
};

/** One registry for parser names, manifest metadata and help spellings. */
const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
	{
		parser: "pretty",
		name: "--pretty",
		group: "global",
		applies_to: "data commands and supported single-object commands",
		machine_readable: false,
		instruction:
			"Never invoke --pretty from an agent; it emits unstable human-readable output.",
	},
	{
		parser: "no-cache",
		name: "--no-cache",
		group: "global",
		applies_to: "data commands",
	},
	{
		parser: "max-requests",
		name: "--max-requests <n>",
		group: "global",
		applies_to: "data commands",
	},
	{
		parser: "limit",
		name: "--limit <n>",
		group: "global",
		applies_to: "list and search commands",
	},
	{
		parser: "resolve",
		name: "--resolve",
		group: "global",
		applies_to: "data commands",
	},
	{
		parser: "resolve-budget",
		name: "--resolve-budget <n>",
		group: "global",
		applies_to: "data commands",
	},
	{
		parser: "token-file",
		name: "--token-file <path>",
		group: "global",
		applies_to: "data commands and pd auth status",
	},
	{
		parser: "verbose",
		name: "--verbose",
		group: "global",
		applies_to: "data commands",
	},
	{
		parser: "fields",
		name: "--fields <a,b>",
		group: "global",
		applies_to: "data commands",
	},
	{ parser: "ids", name: "--ids <a,b>", group: "command", enumerable: true },
	{
		parser: "owner-id",
		name: "--owner-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "person-id",
		name: "--person-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "org-id",
		name: "--org-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "organization-id",
		name: "--organization-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "deal-id",
		name: "--deal-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "pipeline-id",
		name: "--pipeline-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "stage-id",
		name: "--stage-id <n>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "filter-id",
		name: "--filter-id <n>",
		group: "command",
		enumerable: false,
	},
	{
		parser: "status",
		name: "--status <name>",
		group: "command",
		enumerable: true,
	},
	{ parser: "done", name: "--done", group: "command", enumerable: true },
	{
		parser: "not-done",
		name: "--not-done",
		group: "command",
		enumerable: true,
	},
	{
		parser: "updated-since",
		name: "--updated-since <timestamp>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "updated-until",
		name: "--updated-until <timestamp>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "sort-by",
		name: "--sort-by <field>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "sort-direction",
		name: "--sort-direction <asc|desc>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "entity",
		name: "--entity <name>",
		group: "command",
		enumerable: true,
	},
	{ parser: "exact", name: "--exact", group: "command", enumerable: true },
	{
		parser: "search-in",
		name: "--search-in <a,b>",
		group: "command",
		enumerable: true,
	},
	{
		parser: "types",
		name: "--types <a,b>",
		group: "command",
		enumerable: true,
	},
];

const FLAG_NAMES = Object.fromEntries(
	FLAG_DEFINITIONS.flatMap((definition) =>
		definition.parser === undefined
			? []
			: [[definition.parser, definition.name]],
	),
) as Record<Flag, string>;

const dataFlags = (includeLimit: boolean): readonly Flag[] => [
	"pretty",
	"token-file",
	...(includeLimit ? (["limit"] as const) : []),
	"max-requests",
	"resolve-budget",
	"no-cache",
	"resolve",
	"verbose",
	"fields",
];

const GLOBAL_DATA_FLAGS = dataFlags(false);
const LIST_DATA_FLAGS = dataFlags(true);

const manifestFlag = (definition: FlagDefinition) => ({
	name: definition.name,
	...(definition.applies_to === undefined
		? {}
		: { applies_to: definition.applies_to }),
	...(definition.enumerable === undefined
		? {}
		: { enumerable: definition.enumerable }),
	...(definition.machine_readable === undefined
		? {}
		: { machine_readable: definition.machine_readable }),
	...(definition.instruction === undefined
		? {}
		: { instruction: definition.instruction }),
});

const GLOBAL_FLAGS = FLAG_DEFINITIONS.flatMap((definition) =>
	definition.group === "global" ? [manifestFlag(definition)] : [],
);
const COMMAND_FLAGS = FLAG_DEFINITIONS.flatMap((definition) =>
	definition.group === "command" ? [manifestFlag(definition)] : [],
);

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
	readonly flag_values?: Readonly<Record<string, readonly string[]>>;
	readonly delivery: "streams" | "collects";
	readonly selectable_fields?: readonly string[];
	readonly selectable_fields_by_entity?: Readonly<
		Record<Entity, readonly string[]>
	>;
	/** Internal parser names; omitted from the emitted manifest. */
	readonly parserFlags: readonly Flag[];
};

type ResourceDefinition = {
	readonly name: string;
	readonly description: string;
	readonly commands: readonly CommandDefinition[];
};

type ManifestFlag = ReturnType<typeof manifestFlag>;

type OtherDefinition = {
	readonly name: string;
	readonly description: string;
	readonly arguments: readonly CommandArgument[];
	readonly flags: readonly string[];
	readonly delivery: "streams" | "collects";
	/** Internal parser names; omitted from the emitted manifest. */
	readonly parserFlags: readonly Flag[];
};

export type CommandTable = {
	readonly resources: readonly ResourceDefinition[];
	readonly other: readonly OtherDefinition[];
	readonly globalFlags: readonly ManifestFlag[];
	readonly commandFlags: readonly ManifestFlag[];
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
	flagValues,
	selectableFields,
	selectableFieldsByEntity,
}: {
	name: string;
	description: string;
	arguments?: readonly CommandArgument[];
	parserFlags: readonly Flag[];
	flagValues?: Readonly<Record<string, readonly string[]>>;
	selectableFields?: readonly string[];
	selectableFieldsByEntity?: Readonly<Record<Entity, readonly string[]>>;
}): CommandDefinition => ({
	name,
	description,
	arguments: args,
	flags: parserFlags.map((flag) => FLAG_NAMES[flag]),
	...(flagValues === undefined ? {} : { flag_values: flagValues }),
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
		const listFlagValues = {
			...(live.filterFlags.includes("sort-by")
				? { [FLAG_NAMES["sort-by"]]: live.sortFields }
				: {}),
			...(live.filterFlags.includes("sort-direction")
				? { [FLAG_NAMES["sort-direction"]]: ["asc", "desc"] }
				: {}),
			...(live.filterFlags.includes("status")
				? { [FLAG_NAMES.status]: DEAL_STATUSES }
				: {}),
		};
		commands.push(
			command({
				name: `pd ${name} list`,
				description: `List ${name}; fetches the complete result unless --limit is given.`,
				parserFlags: [...LIST_DATA_FLAGS, ...live.filterFlags],
				flagValues: listFlagValues,
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
			? (Object.fromEntries(
					ENTITIES.map((entity) => [
						entity,
						cached.source(entity)?.fields ?? [],
					]),
				) as Record<Entity, readonly string[]>)
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
				flagValues: {
					[FLAG_NAMES["search-in"]]: search.searchIn,
					...(search.itemTypes === undefined
						? {}
						: { [FLAG_NAMES.types]: search.itemTypes }),
					...(name === "deals"
						? { [FLAG_NAMES.status]: ["open", "won", "lost"] }
						: {}),
				},
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
	globalFlags: GLOBAL_FLAGS,
	commandFlags: COMMAND_FLAGS,
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
			description:
				"Emit the complete machine-readable command contract as one JSON object.",
			arguments: [],
			flags: [],
			delivery: "collects",
			parserFlags: [],
		},
		{
			name: "pd cache info",
			description: "Describe local cache entries and blocked sentinels.",
			arguments: [],
			flags: [FLAG_NAMES.pretty],
			delivery: "collects",
			parserFlags: ["pretty"],
		},
		{
			name: "pd cache clear",
			description:
				"Delete local cache entries while preserving blocked sentinels.",
			arguments: [],
			flags: [FLAG_NAMES.pretty],
			delivery: "collects",
			parserFlags: ["pretty"],
		},
		{
			name: "pd auth status",
			description: "Report credential discovery without making a request.",
			arguments: [],
			flags: [FLAG_NAMES["token-file"], FLAG_NAMES.pretty],
			delivery: "collects",
			parserFlags: ["token-file", "pretty"],
		},
		{
			name: "pd docs",
			description: "Emit the AGENTS.md documentation embedded in this binary.",
			arguments: [],
			flags: [],
			delivery: "collects",
			parserFlags: [],
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

export const otherCommandNamed = (
	name: string,
	table: CommandTable = COMMAND_TABLE,
): OtherDefinition | undefined =>
	table.other.find((candidate) => candidate.name === name);

const manifestOther = (definition: OtherDefinition) => ({
	name: definition.name,
	description: definition.description,
	arguments: definition.arguments,
	flags: definition.flags,
	delivery: definition.delivery,
});

const manifestCommand = (definition: CommandDefinition) => ({
	name: definition.name,
	description: definition.description,
	arguments: definition.arguments,
	flags: definition.flags,
	...(definition.flag_values === undefined
		? {}
		: { flag_values: definition.flag_values }),
	delivery: definition.delivery,
	...(definition.selectable_fields === undefined
		? {}
		: { selectable_fields: definition.selectable_fields }),
	...(definition.selectable_fields_by_entity === undefined
		? {}
		: {
				selectable_fields_by_entity: definition.selectable_fields_by_entity,
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
		other: table.other.map(manifestOther),
	},
	global_flags: table.globalFlags.map((flag) => ({ ...flag })),
	command_flags: table.commandFlags.map((flag) => ({ ...flag })),
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

const section = (
	title: string,
	rows: readonly { name: string; description: string }[],
): string =>
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

const flagHelpLine = (
	definition: CommandDefinition | OtherDefinition,
	flag: string,
	table: CommandTable,
): string => {
	const instruction = table.globalFlags.find(
		(candidate) => candidate.name === flag,
	)?.instruction;
	if (instruction !== undefined) return `  ${flag}\n      ${instruction}`;
	if (!("flag_values" in definition)) return `  ${flag}`;
	const values = definition.flag_values?.[flag];
	return values === undefined
		? `  ${flag}`
		: `  ${flag} (${values.join(", ")})`;
};

const commandHelp = (
	definition: CommandDefinition | OtherDefinition,
	table: CommandTable,
): string => {
	const positional = definition.arguments
		.flatMap((argument) =>
			argument.name.startsWith("--") ? [] : [`<${argument.name}>`],
		)
		.join(" ");
	const usage = `${definition.name}${positional === "" ? "" : ` ${positional}`}${definition.flags.length === 0 ? "" : " [flags]"}`;
	const flags =
		definition.flags.length === 0
			? ""
			: `\n\nFLAGS\n${definition.flags
					.map((flag) => flagHelpLine(definition, flag, table))
					.join("\n")}`;
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
			"A Pipedrive API token is write-capable. Handing pd an administrator's token gives a fully privileged credential to a program whose safety rests on its own correctness. pd's code refuses writes; use a restricted Pipedrive permission set for account-level protection.\n\n" +
			"USAGE\n  pd <resource> <verb> [argument] [flags]\n\n" +
			"GLOBAL FLAGS\n" +
			table.globalFlags
				.map(
					(flag) =>
						`  ${flag.name}\n      ${flag.instruction ?? flag.applies_to ?? ""}`,
				)
				.join("\n") +
			"\n\n" +
			section("RESOURCES", table.resources) +
			"\n\n" +
			section("OTHER", table.other) +
			"\n"
		);
	}

	const exact = `pd ${words.join(" ")}`;
	const data = commandNamed(exact, table);
	if (data !== undefined) return commandHelp(data, table);
	const other = table.other.find((candidate) => candidate.name === exact);
	if (other !== undefined) return commandHelp(other, table);

	if (words.length === 1) {
		const resource = table.resources.find(
			(candidate) => candidate.name === words[0],
		);
		if (resource !== undefined) {
			return `${resource.description}\n\n${section("COMMANDS", resource.commands)}\n`;
		}
		const prefix = `pd ${words[0]} `;
		const grouped = table.other.filter((candidate) =>
			candidate.name.startsWith(prefix),
		);
		if (grouped.length > 0) return `${section("COMMANDS", grouped)}\n`;
	}

	return "";
};
