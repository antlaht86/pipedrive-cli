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

export const Arguments = z.object({
  "token-file": z.string().min(1, { error: "--token-file needs a path." }).optional(),
  /** ADR-0003 §1: a record count, never a page size, and with no upper bound. */
  limit: positiveInteger("limit").optional(),
  /** ADR-0010 §3: network requests, no default, the only quantitative guard. */
  "max-requests": positiveInteger("max-requests").optional(),
  /** ADR-0005 §8: skips the cached **read** and still writes the fresh answer. */
  "no-cache": z.boolean().optional(),
  /** ADR-0008: one additive switch for every id-to-name resolution. */
  resolve: z.boolean().optional(),
  /** ADR-0009 §4: required on `fields`, and its value set is checked there. */
  entity: z.string().min(1, { error: "--entity needs a value." }).optional(),
  /** ADR-0016 §1: repeatable values are split and validated by the resource schema. */
  fields: z.array(z.string()).optional(),
});

export type Arguments = z.infer<typeof Arguments>;

export type Flag = keyof Arguments;

/**
 * `--no-cache` is the one flag that takes no value: it is a switch, and
 * `--no-cache=false` is a spelling nobody should have to guess the meaning of.
 */
const FLAG_TYPE: Record<Flag, "string" | "boolean"> = {
  "token-file": "string",
  limit: "string",
  "max-requests": "string",
  "no-cache": "boolean",
  resolve: "boolean",
  entity: "string",
  fields: "string",
};

/** `--a, --b and --c` — the Oxford-less list the refusal below reads best with. */
const listed = (flags: readonly string[]): string => {
  const named = flags.map((flag) => `--${flag}`);
  return named.length < 2
    ? (named[0] ?? "")
    : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1] ?? ""}`;
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
            { type: FLAG_TYPE[flag], ...(flag === "fields" ? { multiple: true } : {}) },
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
export type Positional = "none" | "integer-id" | "code-id";

/**
 * A Pipedrive record id, validated offline and at the same boundary as the
 * flags. The pattern is exact rather than `z.coerce`: `Number(" 42")` is 42 and
 * `Number("42\n")` is 42, and an id an agent did not mean to send should be a
 * usage error rather than a request.
 */
const INTEGER_ID = /^[1-9][0-9]*$/;

export type Parsed = {
  flags: Arguments;
  /** Present on the `get` verb, absent on `list`. */
  id?: string | number;
};

const positionals = (
  command: string,
  positional: Positional,
  found: readonly string[],
): Result<string | number | undefined, PdError> => {
  const wantsId = positional !== "none";
  const extra = found[wantsId ? 1 : 0];
  if (extra !== undefined) {
    return err(
      pdError({
        code: "usage",
        message: wantsId
          ? `${command} takes one id; got ${found.length} arguments.`
          : `${command} takes no arguments; got ${extra}.`,
      }),
    );
  }

  if (!wantsId) return ok(undefined);

  const id = found[0];
  if (id === undefined) {
    return err(pdError({ code: "usage", message: `${command} needs an id.` }));
  }

  if (positional === "code-id") {
    // ADR-0009 §3: a field's id is its `field_code` — a hex hash for a custom
    // field, a plain name for a standard one. Whether it exists is a question
    // for the cached list rather than for a pattern here.
    return id === ""
      ? err(
          pdError({
            code: "usage",
            message: `${command} takes a field code; got an empty one.`,
          }),
        )
      : ok(id);
  }

  return INTEGER_ID.test(id)
    ? ok(Number(id))
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
  tokenise(command, flags)(argv).andThen(({ values, positionals: found }) =>
    positionals(command, positional, found).andThen((id) => {
      const parsed = Arguments.safeParse(values);
      return parsed.success
        ? ok({ flags: parsed.data, ...(id === undefined ? {} : { id }) })
        : err(
            pdError({
              code: "usage",
              // Each schema above names its own flag, so the issues are already
              // sentences a caller can act on and need no path prefix.
              message: parsed.error.issues.map((issue) => issue.message).join(" "),
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
