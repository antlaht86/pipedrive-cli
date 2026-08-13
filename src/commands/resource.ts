/**
 * `pd <resource> list` and `pd <resource> get <id>` — one command for all five
 * live resources.
 *
 * This is ticket 05's `deals-list.ts` with the resource lifted into a parameter
 * and the second verb added. Argument parsing, credential resolution, the walk
 * or the by-id fetch, two-stage validation, the writer, the error union and the
 * exit codes are shared by construction rather than by five files agreeing.
 *
 * ## Everything failing here still ends in a trailer
 *
 * ADR-0002's last-line invariant is total. A `usage` error on a data command is
 * not a bare one-line refusal — it is an `error` trailer carrying
 * `complete: false` and four zero counters, because a consumer reading the last
 * line and two fields must not have to know which failures happened before the
 * stream started. The same holds for a missing credential.
 *
 * ## Injected seams, and nothing else
 *
 * `transport`, `clock` and `sink` are constructor parameters, on exactly the
 * reasoning ADR-0019 §4 used for the clock. There is no test-only flag and no
 * test-only environment variable (ADR-0019 §5); production passes
 * `globalThis.fetch`, the system clock and `process.stdout.write` explicitly.
 */

import { parseArgs } from "node:util";

import { Result, err, ok } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../lib/errors.ts";
import { resolveCredential } from "../lib/auth/credentials.ts";
import type { Clock } from "../lib/pipedrive/clock.ts";
import { createGuardedFetch } from "../lib/pipedrive/guarded-fetch.ts";
import type { Transport } from "../lib/pipedrive/guarded-fetch.ts";
import { createPipedriveClient } from "../lib/pipedrive/client.ts";
import type { Resource } from "../lib/pipedrive/resources.ts";
import { NdjsonWriter, type Sink } from "../lib/output/ndjson-writer.ts";
import { stream } from "../lib/output/stream.ts";

/** ADR-0009 §1, minus `search`, which arrives with ticket 14. */
export type Verb = "list" | "get";

export type ResourceCommandInput = {
  resource: Resource;
  verb: Verb;
  /** Everything after `pd <resource> <verb>`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  transport?: Transport;
  clock?: Clock;
  sink?: Sink;
  stderr?: (line: string) => void;
};

/**
 * ADR-0012 §3 refuses `--token <value>` in any form: argv is readable by every
 * other user on the machine. The refusal is explicit rather than implicit in an
 * unknown-flag error, because the flag is the one an operator reaches for first
 * and the reason is worth stating.
 */
const TOKEN_FLAG = /^--token(=.*)?$/;

const TOKEN_REFUSAL = pdError({
  code: "usage",
  message:
    "There is no --token flag. argv is readable by every other user on this " +
    "machine, so pd takes a token only from --token-file, the PD_API_TOKEN " +
    "environment variable, or the credentials file.",
});

/**
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
 */

/**
 * The value both quantitative flags take — ADR-0003: a positive integer of 1 or
 * greater, and nothing else. `0`, a negative number, a fraction and a
 * non-number are all `usage`, exit 2, and they are refused offline: no request
 * is made to discover that `--limit 0` was a typo.
 *
 * The pattern is exact rather than `z.coerce`, for the reason `Id` below gives:
 * `Number(" 4")` is 4, `Number("1e3")` is 1000 and `Number("")` is 0, so a
 * coercion would silently accept three spellings the caller did not write.
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

const Arguments = z.object({
  "token-file": z.string().min(1, { error: "--token-file needs a path." }).optional(),
  /** ADR-0003 §1: a record count, never a page size, and with no upper bound. */
  limit: positiveInteger("limit").optional(),
  /** ADR-0010 §3: network requests, no default, the only quantitative guard. */
  "max-requests": positiveInteger("max-requests").optional(),
});

type Arguments = z.infer<typeof Arguments>;

/**
 * ADR-0003: `--limit` **does not exist on non-list commands**, so passing it to
 * `pd deals get 42` is a usage error rather than a silent no-op. It is left out
 * of the option table for that verb, which makes the refusal `parseArgs`'s
 * unknown-option path and keeps one wording for every flag a command lacks.
 *
 * `--max-requests` is on both. ADR-0003 scopes only the bound to list commands,
 * and ADR-0010 §3 defines the guard over the requests a run makes — `get` is a
 * run, and a `get` under a spent ceiling is the same refusal for the same
 * reason. Ticket 16's manifest documents the flag under both verbs.
 *
 * The names are bare, and the `--` is added where a name is printed. They are
 * typed as keys of `Arguments`, so the option table and the schema cannot drift
 * apart: a flag `parseArgs` would accept and the schema would not validate is a
 * compile error rather than a value that reaches the walk unchecked.
 */
const FLAGS: Record<Verb, readonly (keyof Arguments)[]> = {
  list: ["token-file", "limit", "max-requests"],
  get: ["token-file", "max-requests"],
};

/** `--a, --b and --c` — the Oxford-less list the refusal below reads best with. */
const listed = (flags: readonly string[]): string => {
  const named = flags.map((flag) => `--${flag}`);
  return named.length < 2
    ? (named[0] ?? "")
    : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1] ?? ""}`;
};

/**
 * A Pipedrive record id, validated offline and at the same boundary as the
 * flags. The pattern is exact rather than `z.coerce`: `Number(" 42")` is 42 and
 * `Number("42\n")` is 42, and an id an agent did not mean to send should be a
 * usage error rather than a request.
 */
const Id = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number);

/**
 * `parseArgs`'s own prose is Node's, and it advises a `--` positional syntax
 * these commands do not have. The message an agent reads should name the flag
 * and the flags that exist, so the unknown-option case is reworded and every
 * other grammar failure passes through.
 */
const usageMessage = (
  command: string,
  verb: Verb,
  cause: unknown,
): string => {
  const node = cause instanceof Error ? cause : undefined;
  const code = (node as { code?: string } | undefined)?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /'([^']+)'/.exec(node?.message ?? "")?.[1] ?? "that flag";
    return `${command} does not accept ${flag}. It takes ${listed(FLAGS[verb])} and no other flag.`;
  }
  return node?.message ?? String(cause);
};

const tokenise = (command: string, verb: Verb) =>
  Result.fromThrowable(
    (argv: readonly string[]) =>
      parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: true,
        options: Object.fromEntries(
          FLAGS[verb].map((flag) => [flag, { type: "string" as const }]),
        ),
      }),
    (cause): PdError =>
      pdError({ code: "usage", message: usageMessage(command, verb, cause) }),
  );

type Parsed = {
  flags: Arguments;
  /** Present on `get`, absent on `list`. */
  id?: number;
};

/**
 * The arity difference between the two verbs is the whole of what varies:
 * `list` takes no positional, `get` takes exactly one and it is an id.
 */
const positionals = (
  command: string,
  verb: Verb,
  found: readonly string[],
): Result<number | undefined, PdError> => {
  const extra = found[verb === "get" ? 1 : 0];
  if (extra !== undefined) {
    return err(
      pdError({
        code: "usage",
        message:
          verb === "get"
            ? `${command} takes one id; got ${found.length} arguments.`
            : `${command} takes no arguments; got ${extra}.`,
      }),
    );
  }

  if (verb === "list") return ok(undefined);

  const id = found[0];
  if (id === undefined) {
    return err(
      pdError({ code: "usage", message: `${command} needs an id.` }),
    );
  }
  const parsed = Id.safeParse(id);
  return parsed.success
    ? ok(parsed.data)
    : err(
        pdError({
          code: "usage",
          message: `${command} takes a positive integer id; got ${id}.`,
        }),
      );
};

const parse = (
  command: string,
  verb: Verb,
  argv: readonly string[],
): Result<Parsed, PdError> =>
  tokenise(command, verb)(argv).andThen(({ values, positionals: found }) =>
    positionals(command, verb, found).andThen((id) => {
      const flags = Arguments.safeParse(values);
      return flags.success
        ? ok({ flags: flags.data, ...(id === undefined ? {} : { id }) })
        : err(
            pdError({
              code: "usage",
              // Each schema above names its own flag, so the issues are already
              // sentences a caller can act on and need no path prefix.
              message: flags.error.issues.map((issue) => issue.message).join(" "),
            }),
          );
    }),
  );

export const resourceCommand = async ({
  resource,
  verb,
  argv,
  platform,
  env,
  home,
  transport,
  clock,
  sink,
  stderr,
}: ResourceCommandInput): Promise<number> => {
  const command = `pd ${resource.name} ${verb}`;

  // Parsing is pure and comes first, because the two things built below take
  // their configuration from it: the gate needs `--max-requests` before its
  // first request, and the writer needs to know whether the run is bounded
  // before its first record. A parse failure is still reported through the
  // writer, so the trailer invariant holds either way.
  const refused = argv.some((arg) => TOKEN_FLAG.test(arg));
  const parsed = parse(command, verb, argv);
  const flags = parsed.isOk() ? parsed.value.flags : undefined;

  const guarded = createGuardedFetch({
    ...(transport === undefined ? {} : { transport }),
    ...(clock === undefined ? {} : { clock }),
    ...(flags?.["max-requests"] === undefined
      ? {}
      : { maxRequests: flags["max-requests"] }),
  });

  const writer = new NdjsonWriter({
    recordType: resource.recordType,
    rename: resource.rename,
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

  const id = parsed.value.id;
  return stream(
    id === undefined
      ? resource.list(client, flags?.limit)
      : resource.get(client, id),
    writer,
  );
};
