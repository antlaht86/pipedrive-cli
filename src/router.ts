/**
 * The resource grammar, and the one refusal that ends an agent's search.
 *
 * ADR-0009 §1 fixes `pd <resource> <verb> [id] [flags]`. This module matches an
 * invocation against the resource table and dispatches it; everything it does
 * not recognise gets a single `usage` error whose message says `pd` has no
 * write commands **at all** and points at `pd manifest`.
 *
 * ## Why `usage` and not `unknown_command`
 *
 * ADR-0009 §6 and ADR-0017 §2 both write `code: "unknown_command"`. ADR-0001
 * owns the `code` union and does not contain it, and the union is closed. The
 * response to an unrecognised command is identical to every other usage error —
 * exit 2, `retry: "never"`, nothing to wait for — so it earns no variant, and
 * inventing one would break the promise that an agent can enumerate the codes.
 *
 * ## Why the refusal teaches
 *
 * ADR-0009 §6: one probe ends the search. A generic "unknown command" invites
 * an agent to try `update`, then `delete`, then `new`, spending a turn on each.
 * The message therefore names the absence of writes rather than the presence of
 * a verb list — and it must **not** claim the only verbs are `list` and `get`,
 * because ADR-0017 §1 added `search`.
 *
 * ## The refusal carries a trailer
 *
 * A consumer that reads the last line and two fields must not have to know
 * which failures happen before a stream starts (ADR-0002). So the refusal is
 * the same `error` trailer a data command writes, with four zero counters —
 * unlike `pd auth status`, which ADR-0009 §8 puts outside the NDJSON grammar
 * altogether and which keeps its own bare one-line failure.
 */

import { pdError, type PdError } from "./lib/errors.ts";
import { resourceNamed } from "./lib/pipedrive/resources.ts";
import { cachedResourceNamed } from "./lib/pipedrive/cached.ts";
import { resourceCommand, type Verb } from "./commands/resource.ts";
import { cachedCommand } from "./commands/cached.ts";
import type { Clock } from "./lib/pipedrive/clock.ts";
import type { Transport } from "./lib/pipedrive/guarded-fetch.ts";
import {
  errorLine,
  stderrSink,
  stdoutSink,
  ZERO_COUNTERS,
  type Sink,
} from "./lib/output/ndjson-writer.ts";

export type RouteInput = {
  /** Everything after `pd`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  transport?: Transport;
  clock?: Clock;
  sink?: Sink;
  stderr?: Sink;
};

const VERBS = new Set<string>(["list", "get"]);

const isVerb = (value: string | undefined): value is Verb =>
  value !== undefined && VERBS.has(value);

/**
 * What to quote back at the caller. Only the leading non-flag tokens are
 * echoed: a flag may carry a value, and `pd frobnicate --token sekrit` must not
 * put that value in an error message that an agent will log.
 */
const probe = (argv: readonly string[]): string => {
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-") || words.length === 3) break;
    words.push(arg);
  }
  return words.join(" ");
};

/**
 * The read-only half, on every refusal. It names the absence of writes and
 * delegates the inventory to `pd manifest`; it does not enumerate verbs,
 * because ADR-0017 §1 added a third one.
 */
const READ_ONLY =
  "pd is read-only: it issues GET requests only and has no write commands at " +
  "all, so no spelling of create, update or delete exists to find. Run pd " +
  "manifest for the commands that do exist.";

/**
 * Three openings, because they are three different mistakes and telling an
 * agent the wrong one restarts the search the message exists to end. `pd
 * persons` is not a misspelled noun — the noun is right and the verb is
 * missing — so saying `pd` has no command `persons` would invite the very
 * `pd people` probe ADR-0009 §5 refuses to answer.
 */
const unrecognised = (
  argv: readonly string[],
  known: boolean,
): PdError => {
  const attempted = probe(argv);
  const missingVerb = known && argv[1] === undefined;
  return pdError({
    code: "usage",
    message:
      (attempted === ""
        ? "pd needs a command. "
        : missingVerb
          ? `pd ${attempted} needs a verb. `
          : `pd has no command '${attempted}'. `) + READ_ONLY,
    details: { ...(attempted === "" ? {} : { attempted }) },
  });
};

/**
 * The refusal, written straight rather than through `NdjsonWriter`: the writer
 * is constructed around a `record_type`, and an unrecognised command has none.
 */
const refuse = (error: PdError, sink: Sink, stderr: Sink): number => {
  sink(`${JSON.stringify(errorLine(error, ZERO_COUNTERS))}\n`);
  stderr(`pd: ${error.message}\n`);
  return error.exit_code;
};

export const route = async ({
  argv,
  platform,
  env,
  home,
  transport,
  clock,
  sink = stdoutSink,
  stderr = stderrSink,
}: RouteInput): Promise<number> => {
  const noun = argv[0];
  const resource = noun === undefined ? undefined : resourceNamed(noun);
  // The two tables are disjoint and are consulted in turn rather than merged: a
  // live resource walks a cursor, a cached one loads a whole list from disk,
  // and the commands behind them take different flags (ADR-0005 §1).
  const cached = noun === undefined ? undefined : cachedResourceNamed(noun);
  const verb = argv[1];

  const common = {
    argv: argv.slice(2),
    platform,
    env,
    home,
    ...(transport === undefined ? {} : { transport }),
    ...(clock === undefined ? {} : { clock }),
    sink,
    stderr,
  };

  if (!isVerb(verb)) {
    return refuse(
      unrecognised(argv, resource !== undefined || cached !== undefined),
      sink,
      stderr,
    );
  }

  if (resource !== undefined) return resourceCommand({ resource, verb, ...common });
  if (cached !== undefined) return cachedCommand({ resource: cached, verb, ...common });

  // A verb `pd` knows on a noun it does not: `pd frobnicate list`.
  return refuse(unrecognised(argv, false), sink, stderr);
};
