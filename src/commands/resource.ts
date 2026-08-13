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

import { resolveCredential } from "../lib/auth/credentials.ts";
import type { Clock } from "../lib/pipedrive/clock.ts";
import { createGuardedFetch } from "../lib/pipedrive/guarded-fetch.ts";
import type { Transport } from "../lib/pipedrive/guarded-fetch.ts";
import { createPipedriveClient } from "../lib/pipedrive/client.ts";
import type { Resource } from "../lib/pipedrive/resources.ts";
import { NdjsonWriter, type Sink } from "../lib/output/ndjson-writer.ts";
import { stream } from "../lib/output/stream.ts";
import {
  TOKEN_REFUSAL,
  parseArguments,
  refusesToken,
  type Flag,
} from "./arguments.ts";

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
 * ADR-0003: `--limit` **does not exist on non-list commands**, so passing it to
 * `pd deals get 42` is a usage error rather than a silent no-op. It is left out
 * of the flag list for that verb, which makes the refusal `parseArgs`'s
 * unknown-option path and keeps one wording for every flag a command lacks.
 *
 * `--max-requests` is on both. ADR-0003 scopes only the bound to list commands,
 * and ADR-0010 §3 defines the guard over the requests a run makes — `get` is a
 * run, and a `get` under a spent ceiling is the same refusal for the same
 * reason. Ticket 16's manifest documents the flag under both verbs.
 *
 * `--no-cache` is absent from both: these five resources are never cached
 * (ADR-0005 §1), and a flag that does nothing is a flag an agent spends a turn
 * discovering does nothing. Ticket 11 adds it here, when `--resolve` gives it
 * something to skip.
 *
 * The names are bare, and the `--` is added where a name is printed. They are
 * typed as flags of the shared schema, so the list and the schema cannot drift
 * apart: a flag `parseArgs` would accept and the schema would not validate is a
 * compile error rather than a value that reaches the walk unchecked.
 */
const FLAGS: Record<Verb, readonly Flag[]> = {
  list: ["token-file", "limit", "max-requests"],
  get: ["token-file", "max-requests"],
};

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
  const refused = refusesToken(argv);
  const parsed = parseArguments({
    command,
    flags: FLAGS[verb],
    positional: verb === "get" ? "integer-id" : "none",
    argv,
  });
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

  // `integer-id` above is what makes this a number; the shared parser also
  // serves `pd fields get <field_code>`, whose id is a string.
  const id = parsed.value.id;
  return stream(
    typeof id === "number"
      ? resource.get(client, id)
      : resource.list(client, flags?.limit),
    writer,
  );
};
