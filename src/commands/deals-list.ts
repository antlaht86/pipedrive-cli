/**
 * `pd deals list` — the tracer bullet of ticket 05.
 *
 * Argument parsing, credential resolution, the cursor walk, two-stage
 * validation, deduplication, the writer, the error union and the exit codes, end
 * to end. Every one of those lives in a module of its own; this file is the
 * wiring, and it is deliberately thin so that ticket 07's eight other resources
 * are a table entry rather than a copy of it.
 *
 * ## Everything failing here still ends in a trailer
 *
 * ADR-0002's last-line invariant is total. A `usage` error on this command is
 * not `cli.ts`'s bare one-line `fail()` — it is an `error` trailer carrying
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
import {
  DEAL_RECORD_TYPE,
  walkDeals,
} from "../lib/pipedrive/deals.ts";
import { NdjsonWriter, type Sink } from "../lib/output/ndjson-writer.ts";
import { stream } from "../lib/output/stream.ts";

export type DealsListInput = {
  /** Everything after `pd deals list`. */
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
 * `parseArgs`'s own prose is Node's, and it advises a `--` positional syntax
 * `pd deals list` does not have. The message an agent reads should name the flag
 * and the flags that exist, so the unknown-option case is reworded and every
 * other grammar failure passes through.
 */
const usageMessage = (cause: unknown): string => {
  const node = cause instanceof Error ? cause : undefined;
  const code = (node as { code?: string } | undefined)?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /'([^']+)'/.exec(node?.message ?? "")?.[1] ?? "that flag";
    return `pd deals list does not accept ${flag}. It takes --token-file and no other flag.`;
  }
  return node?.message ?? String(cause);
};

const tokenise = Result.fromThrowable(
  (argv: readonly string[]) =>
    parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: { "token-file": { type: "string" } },
    }),
  (cause): PdError => pdError({ code: "usage", message: usageMessage(cause) }),
);

const parse = (argv: readonly string[]): Result<Arguments, PdError> =>
  tokenise(argv).andThen(({ values, positionals }) => {
    const extra = positionals[0];
    if (extra !== undefined) {
      return err(
        pdError({
          code: "usage",
          message: `pd deals list takes no arguments; got ${extra}.`,
        }),
      );
    }
    const parsed = Arguments.safeParse(values);
    return parsed.success
      ? ok(parsed.data)
      : err(
          pdError({
            code: "usage",
            message: parsed.error.issues
              .map((issue) => `--${issue.path.join(".")}: ${issue.message}`)
              .join(" "),
          }),
        );
  });

export const dealsList = async ({
  argv,
  platform,
  env,
  home,
  transport,
  clock,
  sink,
  stderr,
}: DealsListInput): Promise<number> => {
  const guarded = createGuardedFetch({
    ...(transport === undefined ? {} : { transport }),
    ...(clock === undefined ? {} : { clock }),
  });

  const writer = new NdjsonWriter({
    recordType: DEAL_RECORD_TYPE,
    requests: guarded.dispatches,
    ...(sink === undefined ? {} : { sink }),
    ...(stderr === undefined ? {} : { stderr }),
  });

  if (argv.some((arg) => TOKEN_FLAG.test(arg))) {
    return writer.error(TOKEN_REFUSAL);
  }

  const parsed = parse(argv);
  if (parsed.isErr()) return writer.error(parsed.error);

  const credential = resolveCredential({
    platform,
    env,
    home,
    ...(parsed.value["token-file"] === undefined
      ? {}
      : { tokenFile: parsed.value["token-file"] }),
  });
  if (credential.isErr()) return writer.error(credential.error);

  // ADR-0012 §3 and ADR-0021 §8: a credentials file the rest of the machine can
  // read is a `warning`, not a refusal. It rides the stream like any other.
  for (const warning of credential.value.warnings) writer.warn(warning);

  const client = createPipedriveClient({
    token: credential.value.token,
    guarded,
  });

  return stream(walkDeals(client), writer);
};
