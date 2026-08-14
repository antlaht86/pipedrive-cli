/**
 * The opening every data command shares, in one place.
 *
 * `resource.ts` and `cached.ts` differ in their middle — a cursor walk against a
 * whole cached list — and in nothing else. Both parse the same way, refuse
 * `--token` the same way, build the same gate from `--max-requests`, construct
 * the same writer, resolve the same credential chain and emit its warnings the
 * same way. Written twice, the two would agree until the day one of them was
 * edited; written here, they cannot disagree at all.
 *
 * ## The order is load-bearing, not stylistic
 *
 * 1. **Parse**, because the gate needs `--max-requests` before its first request
 *    and the writer needs to know whether the run is bounded before its first
 *    record.
 * 2. **The writer**, because every refusal below it is reported *through* it:
 *    ADR-0002's last-line invariant is total, so a `usage` error on a data
 *    command is an `error` trailer with four zero counters rather than a bare
 *    one-line refusal.
 * 3. **`--token`**, ahead of the parse failure it would otherwise produce: it
 *    tokenises as an unknown flag, and the generic wording would drop the one
 *    sentence saying where a token may come from instead.
 * 4. **`resolve`**, the caller's own offline step — picking the field schema
 *    `--entity` names, and refusing when it names none. It runs before the
 *    credential so that a usage error on a machine with no token is still a
 *    usage error, and it hands its answer back rather than being asked the same
 *    question twice.
 * 5. **The credential**, last, because it is the only step that touches the
 *    filesystem.
 * 6. **The `blocked` sentinel**, which needs the credential's fingerprint and so
 *    cannot come earlier. It is the last thing between the caller and the
 *    network, and every command that makes a request passes through here — which
 *    is what makes "zero HTTP requests while the block is live" a property of
 *    this file rather than a rule five command modules must remember.
 *
 * ## The error channel is an exit code
 *
 * A failure here has already been written — trailer, stderr line and all — so
 * there is nothing left for the caller to report and the `Err` carries only the
 * code to exit with. That is unusual enough to state, and it is what keeps the
 * exactly-one-trailer invariant a property of this file rather than a rule two
 * callers must remember.
 */

import { err, ok, type Result } from "neverthrow";

import { resolveCredential, type Credential } from "../lib/auth/credentials.ts";
import {
  blockedFromMemory,
  createSentinel,
  type Sentinel,
} from "../lib/cache/sentinel.ts";
import { DEFAULT_RESOLVE_BUDGET } from "../lib/pipedrive/budgets.ts";
import { systemClock, type Clock } from "../lib/pipedrive/clock.ts";
import { createGuardedFetch } from "../lib/pipedrive/guarded-fetch.ts";
import type { GuardedFetch, Transport } from "../lib/pipedrive/guarded-fetch.ts";
import { createPipedriveClient, type PipedriveClient } from "../lib/pipedrive/client.ts";
import { NdjsonWriter, type Sink } from "../lib/output/ndjson-writer.ts";
import type { PdError } from "../lib/errors.ts";
import {
  TOKEN_REFUSAL,
  parseArguments,
  refusesToken,
  type Arguments,
  type Flag,
  type Parsed,
  type Positional,
} from "./arguments.ts";

/** ADR-0009 §1, minus `search`, which arrives with ticket 14. */
export type Verb = "list" | "get";

/** What every data command is handed, whichever table its resource is in. */
export type CommandInput = {
  /** Everything after `pd <resource> <verb>`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  transport?: Transport;
  clock?: Clock;
  sink?: Sink;
  stderr?: Sink;
};

export type PrologueInput<T> = CommandInput & {
  /** `pd deals list` — what every message about this invocation names. */
  command: string;
  flags: readonly Flag[];
  positional: Positional;
  /** ADR-0009: singular, the `record_type` on every emitted line. */
  recordType: string;
  /** Output names for record fields that would shadow a line key. */
  rename?: Readonly<Record<string, string>>;
  /**
   * The offline step of step 4. A command with nothing to resolve returns
   * `ok(undefined)`; `pd fields` returns the source `--entity` names, or the
   * `usage` refusal when it names none.
   */
  resolve: (flags: Arguments) => Result<T, PdError>;
};

export type Started<T> = {
  parsed: Parsed;
  /** Whatever `resolve` produced, already narrowed. */
  resolved: T;
  writer: NdjsonWriter;
  guarded: GuardedFetch;
  client: PipedriveClient;
  credential: Credential;
  clock: Clock;
};

export const begin = <T>({
  command,
  flags: allowed,
  positional,
  recordType,
  rename,
  resolve,
  argv,
  platform,
  env,
  home,
  transport,
  clock = systemClock,
  sink,
  stderr,
}: PrologueInput<T>): Result<Started<T>, number> => {
  const refused = refusesToken(argv);
  const parsed = parseArguments({ command, flags: allowed, positional, argv });
  const flags = parsed.isOk() ? parsed.value.flags : undefined;

  // The gate is built before the credential is — the writer needs its dispatch
  // counter to report a parse failure — and the sentinel cannot exist until the
  // fingerprint does. So the gate is handed a closure over this box, rather than
  // the credential the gate must never learn about (ADR-0010 §6). It is empty on
  // every path that fails before step 5, and every one of those made no request.
  const pending: { sentinel?: Sentinel } = {};

  const guarded = createGuardedFetch({
    ...(transport === undefined ? {} : { transport }),
    clock,
    ...(flags?.["max-requests"] === undefined
      ? {}
      : { maxRequests: flags["max-requests"] }),
    resolveBudget: flags?.["resolve-budget"] ?? DEFAULT_RESOLVE_BUDGET,
    onBlocked: () => pending.sentinel?.record(),
  });

  const writer = new NdjsonWriter({
    recordType,
    requests: guarded.dispatches,
    // ADR-0003: the stderr size warning is for an **unbounded** run. A caller
    // who passed `--limit` has already said how much output it wants.
    bounded: flags?.limit !== undefined,
    resolved: flags?.resolve === true ? "full" : "off",
    ...(rename === undefined ? {} : { rename }),
    ...(sink === undefined ? {} : { sink }),
    ...(stderr === undefined ? {} : { stderr }),
  });

  if (refused) return err(writer.error(TOKEN_REFUSAL));
  if (parsed.isErr()) return err(writer.error(parsed.error));

  const resolved = resolve(parsed.value.flags);
  if (resolved.isErr()) return err(writer.error(resolved.error));

  const credential = resolveCredential({
    platform,
    env,
    home,
    ...(parsed.value.flags["token-file"] === undefined
      ? {}
      : { tokenFile: parsed.value.flags["token-file"] }),
  });
  if (credential.isErr()) return err(writer.error(credential.error));

  // ADR-0012 §3 and ADR-0021 §8: a credentials file the rest of the machine can
  // read is a `warning`, not a refusal. It rides the stream like any other.
  for (const warning of credential.value.warnings) writer.warn(warning);

  // ADR-0010 §6 and §7. The check sits below the credential warnings because
  // those are true regardless of the block and a human reading them is the human
  // this refusal is addressed to. There is **no flag and no environment
  // variable** past this point: a documented escape hatch from the one
  // company-wide safety stop would be advertised by `--help` to the very
  // consumer it exists to stop, and `--no-cache` is defined over cached data
  // rather than over guard state.
  const sentinel = createSentinel({
    platform,
    env,
    home,
    fingerprint: credential.value.fingerprint,
    clock,
  });
  pending.sentinel = sentinel;

  const remaining = sentinel.remaining();
  if (remaining !== undefined) {
    return err(writer.error(blockedFromMemory(remaining, sentinel.path)));
  }

  return ok({
    parsed: parsed.value,
    resolved: resolved.value,
    writer,
    guarded,
    clock,
    credential: credential.value,
    client: createPipedriveClient({ token: credential.value.token, guarded }),
  });
};
