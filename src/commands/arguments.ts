/**
 * Argument parsing for every data command — the half `resource.ts` and
 * `cached.ts` share.
 *
 * `util.parseArgs` tokenises; **zod validates**. CLAUDE.md puts CLI arguments in
 * the same sentence as API responses and environment variables — external input,
 * parsed at the boundary, with the type derived rather than written twice.
 *
 * The two do different jobs and neither replaces the other. `parseArgs` in
 * `strict` mode knows the *grammar*: an unknown flag, a missing value, a
 * positional where none is allowed. The schema knows the *values*, which is the
 * half that grows: `--limit` and `--max-requests` are positive integers with no
 * upper bound, and `positiveInteger` below is where that lives rather than in a
 * hand-rolled check beside it.
 *
 * No CLI framework. One would have added a second opinion about exit codes and
 * a second place for the help text to live.
 *
 * ## One schema, a per-command flag list
 *
 * The schema below holds every flag any data command takes; a command names the
 * subset it accepts, and a flag it does not name is `parseArgs`'s unknown-option
 * path. That keeps one wording for every flag a command lacks, and it is why
 * `--limit` on `pd deals get` and `--entity` on `pd users list` produce the same
 * sentence: neither exists there, for the same reason.
 */

import { parseArgs } from "node:util";

import { Result, err, ok } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../lib/errors.ts";
import { DEAL_STATUSES, SORT_FIELDS } from "../lib/pipedrive/list-filters.ts";
import { ADMIN_SCOPES } from "../lib/pipedrive/users.ts";

/**
 * The value both quantitative flags take — ADR-0003: a positive integer of 1 or
 * greater, and nothing else. `0`, a negative number, a fraction and a
 * non-number are all `usage`, exit 2, and they are refused offline: no request
 * is made to discover that `--limit 0` was a typo.
 *
 * The pattern is exact rather than `z.coerce`, for the reason `INTEGER_ID` below
 * gives: `Number(" 4")` is 4, `Number("1e3")` is 1000 and `Number("")` is 0, so
 * a coercion would silently accept three spellings the caller did not write.
 *
 * The message names its own flag, because the two flags that use this share
 * nothing else and a caller reading `--max-requests: …` under a `--limit`
 * heading would be reading about the wrong one.
 */
const positiveInteger = (flag: string) =>
	z
		.string()
		.regex(/^[1-9][0-9]*$/, {
			error: `--${flag} takes a positive integer of 1 or greater.`,
		})
		.transform(Number);

const positiveId = (flag: string) =>
	z
		.string()
		.regex(/^[1-9][0-9]*$/, {
			error: `--${flag} takes a positive integer id.`,
		})
		.refine((value) => Number.isSafeInteger(Number(value)), {
			error: `--${flag} takes a positive integer id.`,
		})
		.transform(Number);

const ids = z
	.string()
	.refine(
		(value) =>
			value !== "" &&
			value
				.split(",")
				.every(
					(id) => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)),
				),
		{ error: "--ids takes comma-separated positive integer ids." },
	)
	.transform((value) => [...new Set(value.split(",").map((id) => Number(id)))]);

const RFC3339 =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const LEAP_SECOND_DATES = new Set([
	"1972-06-30",
	"1972-12-31",
	"1973-12-31",
	"1974-12-31",
	"1975-12-31",
	"1976-12-31",
	"1977-12-31",
	"1978-12-31",
	"1979-12-31",
	"1981-06-30",
	"1982-06-30",
	"1983-06-30",
	"1985-06-30",
	"1987-12-31",
	"1989-12-31",
	"1990-12-31",
	"1992-06-30",
	"1993-06-30",
	"1994-06-30",
	"1995-12-31",
	"1997-06-30",
	"1998-12-31",
	"2005-12-31",
	"2008-12-31",
	"2012-06-30",
	"2015-06-30",
	"2016-12-31",
]);

const isRfc3339 = (value: string): boolean => {
	const match = RFC3339.exec(value);
	if (match === null) return false;
	const [
		,
		yearText,
		monthText,
		dayText,
		hourText,
		minuteText,
		secondText,
		offsetSign,
		offsetHourText,
		offsetMinuteText,
	] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
	const offsetMinute =
		offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60)
		return false;
	if (offsetHour > 23 || offsetMinute > 59) return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (day < 1 || day > (days[month - 1] ?? 0)) return false;
	if (second !== 60) return true;

	const offset =
		(offsetHour * 60 + offsetMinute) * (offsetSign === "-" ? -1 : 1);
	const utc = new Date(
		Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000,
	);
	const utcDate = [
		utc.getUTCFullYear().toString().padStart(4, "0"),
		(utc.getUTCMonth() + 1).toString().padStart(2, "0"),
		utc.getUTCDate().toString().padStart(2, "0"),
	].join("-");
	return (
		utc.getUTCHours() === 23 &&
		utc.getUTCMinutes() === 59 &&
		LEAP_SECOND_DATES.has(utcDate)
	);
};

const rfc3339 = (flag: string) =>
	z.string().refine(isRfc3339, {
		error: `--${flag} takes an RFC3339 timestamp.`,
	});

export const Arguments = z.object({
	"token-file": z
		.string()
		.min(1, { error: "--token-file needs a path." })
		.optional(),
	/** ADR-0003 §1: a record count, never a page size, and with no upper bound. */
	limit: positiveInteger("limit").optional(),
	/** ADR-0010 §3: network requests, no default, the only quantitative guard. */
	"max-requests": positiveInteger("max-requests").optional(),
	/** ADR-0008 §9: implicit relation requests, defaulted by the resolver. */
	"resolve-budget": positiveInteger("resolve-budget").optional(),
	/** ADR-0002: unstable human table, never a machine-readable stream. */
	pretty: z.boolean().optional(),
	/** ADR-0005 §8: skips the cached **read** and still writes the fresh answer. */
	"no-cache": z.boolean().optional(),
	/** ADR-0008: one additive switch for every id-to-name resolution. */
	resolve: z.boolean().optional(),
	/** ADR-0015: human diagnostics on stderr, never a stdout change. */
	verbose: z.boolean().optional(),
	/** ADR-0017: exact search permits a one-character term. */
	exact: z.boolean().optional(),
	/** ADR-0017: names where to search, never what to emit. */
	"search-in": z
		.string()
		.min(1, { error: "--search-in needs a value." })
		.optional(),
	/** ADR-0017: `items search` narrows its fixed four-type scope. */
	types: z.string().min(1, { error: "--types needs a value." }).optional(),
	/** Search endpoints spell this out, unlike list's `org_id`. */
	"organization-id": positiveId("organization-id").optional(),
	/** ADR-0009 §4: required on `fields`, and its value set is checked there. */
	entity: z.string().min(1, { error: "--entity needs a value." }).optional(),
	/**
	 * Ticket 28: the one value set a cached resource declares for itself. It is
	 * checked here rather than at the filter, so `--admin sales` is refused
	 * offline instead of arriving at a filter that would ignore it.
	 */
	admin: z
		.enum(ADMIN_SCOPES, {
			error: `--admin takes one of: ${ADMIN_SCOPES.join(", ")}.`,
		})
		.optional(),
	/** ADR-0016 §1: repeatable values are split and validated by the resource schema. */
	fields: z.array(z.string()).optional(),
	/** ADR-0018 §3: deduplicated before the API's 100-id chunks are formed. */
	ids: ids.optional(),
	"owner-id": positiveId("owner-id").optional(),
	"person-id": positiveId("person-id").optional(),
	"org-id": positiveId("org-id").optional(),
	"deal-id": positiveId("deal-id").optional(),
	"pipeline-id": positiveId("pipeline-id").optional(),
	"stage-id": positiveId("stage-id").optional(),
	"filter-id": positiveId("filter-id").optional(),
	status: z
		.enum(DEAL_STATUSES, {
			error: "--status takes one of: open, won, lost, deleted.",
		})
		.optional(),
	done: z.boolean().optional(),
	"not-done": z.boolean().optional(),
	"updated-since": rfc3339("updated-since").optional(),
	"updated-until": rfc3339("updated-until").optional(),
	"sort-by": z
		.enum(SORT_FIELDS, {
			error: "--sort-by takes a supported list field.",
		})
		.optional(),
	"sort-direction": z
		.enum(["asc", "desc"], {
			error: "--sort-direction takes one of: asc, desc.",
		})
		.optional(),
});

export type Arguments = z.infer<typeof Arguments>;

export type Flag = keyof Arguments;

/**
 * `--no-cache` is the one flag that takes no value: it is a switch, and
 * `--no-cache=false` is a spelling nobody should have to guess the meaning of.
 */
const FLAG_TYPE: Record<Flag, "string" | "boolean"> = {
	pretty: "boolean",
	"token-file": "string",
	limit: "string",
	"max-requests": "string",
	"resolve-budget": "string",
	"no-cache": "boolean",
	resolve: "boolean",
	verbose: "boolean",
	exact: "boolean",
	"search-in": "string",
	types: "string",
	"organization-id": "string",
	entity: "string",
	admin: "string",
	fields: "string",
	ids: "string",
	"owner-id": "string",
	"person-id": "string",
	"org-id": "string",
	"deal-id": "string",
	"pipeline-id": "string",
	"stage-id": "string",
	"filter-id": "string",
	status: "string",
	done: "boolean",
	"not-done": "boolean",
	"updated-since": "string",
	"updated-until": "string",
	"sort-by": "string",
	"sort-direction": "string",
};

/** `--a, --b and --c` — the Oxford-less list the refusal below reads best with. */
const listed = (flags: readonly string[]): string => {
	const named = flags.map((flag) => `--${flag}`);
	return named.length < 2
		? (named[0] ?? "")
		: `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

/**
 * `parseArgs`'s own prose is Node's, and it advises a `--` positional syntax
 * these commands do not have. The message an agent reads should name the flag
 * and the flags that exist, so the unknown-option case is reworded and every
 * other grammar failure passes through.
 */
const usageMessage = (
	command: string,
	flags: readonly Flag[],
	cause: unknown,
): string => {
	const node = cause instanceof Error ? cause : undefined;
	const code = (node as { code?: string } | undefined)?.code;
	if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
		const flag = /'([^']+)'/.exec(node?.message ?? "")?.[1] ?? "that flag";
		return `${command} does not accept ${flag}. It takes ${listed(flags)} and no other flag.`;
	}
	return node?.message ?? String(cause);
};

const tokenise = (command: string, flags: readonly Flag[]) =>
	Result.fromThrowable(
		(argv: readonly string[]) =>
			parseArgs({
				args: [...argv],
				strict: true,
				allowPositionals: true,
				options: Object.fromEntries(
					flags.map((flag) => [
						flag,
						{
							type: FLAG_TYPE[flag],
							...(flag === "fields" ? { multiple: true } : {}),
						},
					]),
				),
			}),
		(cause): PdError =>
			pdError({ code: "usage", message: usageMessage(command, flags, cause) }),
	);

/**
 * How a command reads its positional. `none` is `list`; the other two are `get`,
 * and they differ only in what an id is allowed to look like — ADR-0009 §3 makes
 * `fields` the one resource whose id is not an integer.
 */
export type Positional = "none" | "integer-id" | "code-id" | "search-term";

/**
 * A Pipedrive record id, validated offline and at the same boundary as the
 * flags. The pattern is exact rather than `z.coerce`: `Number(" 42")` is 42 and
 * `Number("42\n")` is 42, and an id an agent did not mean to send should be a
 * usage error rather than a request.
 */
const INTEGER_ID = /^[1-9][0-9]*$/;

export type Parsed = {
	flags: Arguments;
	/** Present on the `get` verb. */
	id?: string | number;
	/** Present on the `search` verb. */
	term?: string;
};

const positionals = (
	command: string,
	positional: Positional,
	found: readonly string[],
): Result<Pick<Parsed, "id" | "term">, PdError> => {
	const wantsArgument = positional !== "none";
	const extra = found[wantsArgument ? 1 : 0];
	if (extra !== undefined) {
		const argument = positional === "search-term" ? "search term" : "id";
		const message = wantsArgument
			? `${command} takes one ${argument}; got ${found.length} arguments.`
			: `${command} takes no arguments; got ${extra}.`;
		return err(pdError({ code: "usage", message }));
	}

	if (!wantsArgument) return ok({});

	const id = found[0];
	if (id === undefined) {
		return err(
			pdError({
				code: "usage",
				message:
					positional === "search-term"
						? `${command} needs a search term.`
						: `${command} needs an id.`,
			}),
		);
	}

	if (positional === "search-term") {
		return id === ""
			? err(
					pdError({
						code: "usage",
						message: `${command} needs a search term.`,
					}),
				)
			: ok({ term: id });
	}

	if (positional === "code-id") {
		// ADR-0009 §3: a field's id is its `field_code` — the hex field key for a
		// custom field, a plain name for a standard one. Whether it exists is a question
		// for the cached list rather than for a pattern here.
		return id === ""
			? err(
					pdError({
						code: "usage",
						message: `${command} takes a field code; got an empty one.`,
					}),
				)
			: ok({ id });
	}

	return INTEGER_ID.test(id)
		? ok({ id: Number(id) })
		: err(
				pdError({
					code: "usage",
					message: `${command} takes a positive integer id; got ${id}.`,
				}),
			);
};

export type ParseInput = {
	/** `pd deals list` — what every message about this invocation names. */
	command: string;
	flags: readonly Flag[];
	positional: Positional;
	argv: readonly string[];
};

export const parseArguments = ({
	command,
	flags,
	positional,
	argv,
}: ParseInput): Result<Parsed, PdError> =>
	tokenise(
		command,
		flags,
	)(argv).andThen(({ values, positionals: found }) =>
		positionals(command, positional, found).andThen((positionalValues) => {
			const parsed = Arguments.safeParse(values);
			return parsed.success
				? ok({ flags: parsed.data, ...positionalValues })
				: err(
						pdError({
							code: "usage",
							// Each schema above names its own flag, so the issues are already
							// sentences a caller can act on and need no path prefix.
							message: parsed.error.issues
								.map((issue) => issue.message)
								.join(" "),
						}),
					);
		}),
	);

/**
 * ADR-0012 §3 refuses `--token <value>` in any form: argv is readable by every
 * other user on the machine. The refusal is explicit rather than implicit in an
 * unknown-flag error, because the flag is the one an operator reaches for first
 * and the reason is worth stating.
 */
const TOKEN_FLAG = /^--token(=.*)?$/;

export const refusesToken = (argv: readonly string[]): boolean =>
	argv.some((arg) => TOKEN_FLAG.test(arg));

export const TOKEN_REFUSAL = pdError({
	code: "usage",
	message:
		"There is no --token flag. argv is readable by every other user on this " +
		"machine, so pd takes a token only from --token-file, the PD_API_TOKEN " +
		"environment variable, or the credentials file.",
});
