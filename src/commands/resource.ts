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
 * half that grows: ticket 06's `--limit` is a positive integer with no upper
 * bound, and `z.coerce.number().int().positive()` is where that lives rather
 * than in a hand-rolled check beside it.
 *
 * No CLI framework. One would have added a second opinion about exit codes and
 * a second place for the help text to live.
 */
const Arguments = z.object({
  "token-file": z.string().min(1).optional(),
});

type Arguments = z.infer<typeof Arguments>;

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
const usageMessage = (command: string, cause: unknown): string => {
  const node = cause instanceof Error ? cause : undefined;
  const code = (node as { code?: string } | undefined)?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /'([^']+)'/.exec(node?.message ?? "")?.[1] ?? "that flag";
    return `${command} does not accept ${flag}. It takes --token-file and no other flag.`;
  }
  return node?.message ?? String(cause);
};

const tokenise = (command: string) =>
  Result.fromThrowable(
    (argv: readonly string[]) =>
      parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: true,
        options: { "token-file": { type: "string" } },
      }),
    (cause): PdError =>
      pdError({ code: "usage", message: usageMessage(command, cause) }),
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
  tokenise(command)(argv).andThen(({ values, positionals: found }) =>
    positionals(command, verb, found).andThen((id) => {
      const flags = Arguments.safeParse(values);
      return flags.success
        ? ok({ flags: flags.data, ...(id === undefined ? {} : { id }) })
        : err(
            pdError({
              code: "usage",
              message: flags.error.issues
                .map((issue) => `--${issue.path.join(".")}: ${issue.message}`)
                .join(" "),
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

  const guarded = createGuardedFetch({
    ...(transport === undefined ? {} : { transport }),
    ...(clock === undefined ? {} : { clock }),
  });

  const writer = new NdjsonWriter({
    recordType: resource.recordType,
    rename: resource.rename,
    requests: guarded.dispatches,
    ...(sink === undefined ? {} : { sink }),
    ...(stderr === undefined ? {} : { stderr }),
  });

  if (argv.some((arg) => TOKEN_FLAG.test(arg))) {
    return writer.error(TOKEN_REFUSAL);
  }

  const parsed = parse(command, verb, argv);
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
    id === undefined ? resource.list(client) : resource.get(client, id),
    writer,
  );
};
