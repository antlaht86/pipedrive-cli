/**
 * The `blocked` sentinel — ADR-0010 §6 and §7, the **only** cross-invocation
 * state in `pd`.
 *
 * Pipedrive's Cloudflare layer blocks the whole company's `api_token` traffic
 * once, and ADR-0001 forbids retrying that inside a process. The gap that leaves
 * is between processes: an agent looping `pd` fifty times gets fifty fresh retry
 * caps, none of them aware that the previous invocation already met a
 * company-wide block. This file closes it.
 *
 * ## What it is not
 *
 * It is not a cache entry. It shares a directory with the cache and nothing
 * else: it is not in `CacheEntryName`, it does not go through `CacheStore`, it
 * has no TTL table row, and `--no-cache` does not reach it. ADR-0010 §7 puts
 * that in one line — *nothing in the cache surface, read or write, reaches the
 * sentinel* — and keeping the two modules apart is how that stays true rather
 * than remaining an intention.
 *
 * ## It is not written here on a remembered block, and that is the point
 *
 * `record()` is called from **`guardedFetch`'s 403 branch only**, which a run
 * refused from memory never reaches. If the refusal rewrote the file, an agent
 * looping `pd` would push `blocked_at` forward on every attempt and fifteen
 * minutes would become forever — the one bound ADR-0010 §7 promises would be
 * gone, and the file's only remaining exit would be a human deleting it.
 *
 * ## It fails open, in all four ways it can fail
 *
 * Unreadable, not JSON, not this shape, or stamped with a version this binary
 * does not know: all four read as *no block*, and the run proceeds. ADR-0010
 * accepts that direction explicitly, because the alternative is a tool bricked
 * by a corrupt file. A write that fails is silent for the same reason and one
 * more: the run is already ending in `blocked`, so the caller has been told the
 * truth about this invocation, and the sentinel is defence in depth over the
 * next one.
 */

import { pdError, type PdError } from "../errors.ts";
import { cacheDirFor, joinerFor, type CacheDirContext } from "../auth/paths.ts";
import type { Clock } from "../pipedrive/clock.ts";
import {
  makeDirectory,
  parseJson,
  readText,
  removeFile,
  temporaryName,
  writeAtomically,
} from "./files.ts";
import {
  SENTINEL_FILE,
  SENTINEL_SCHEMA_VERSION,
  SENTINEL_TTL_SECONDS,
  StoredSentinel,
} from "./entries.ts";

export type Sentinel = {
  /** The sentinel's file, for `details` and for a human who wants to remove it. */
  readonly path: string;
  /**
   * Seconds of block left, or `undefined` when this credential is not blocked.
   * Reading is also the expiry: a sentinel past its life is deleted here.
   */
  remaining: () => number | undefined;
  /** Records a fresh block. Best effort, and silent when it fails. */
  record: () => void;
};

export type SentinelContext = CacheDirContext & { clock: Clock };

/** What the file on disk says, once. */
export type SentinelReading = {
  /** Milliseconds since the block was recorded. Negative if the clock moved back. */
  ageMs: number;
  /** Milliseconds of block left, `0` for a sentinel that stops nothing. */
  remainingMs: number;
  /** False when the fifteen minutes are spent, or the age is impossible. */
  live: boolean;
};

/**
 * The one reader of the file, so the guard and `pd cache info` cannot come to
 * different conclusions about the same bytes.
 *
 * `undefined` is *no usable sentinel*: absent, unreadable, not JSON, not this
 * shape, or a version this binary does not recognise. All five fail open at the
 * guard (ADR-0010 "Consequences"), so `info` must not give any of them an age —
 * that would describe a block which is not in force.
 *
 * It reads and decides and does **nothing else**. The expiry deletes the file,
 * but that is the caller's move: ADR-0028 §2 puts it in the guard's reader and
 * §5 keeps `info` a reporter.
 */
export const readSentinel = (
  path: string,
  now: number,
): SentinelReading | undefined => {
  const body = readText(path).andThen(parseJson);
  if (body.isErr()) return undefined;

  const parsed = StoredSentinel.safeParse(body.value);
  if (!parsed.success) return undefined;
  if (parsed.data.version !== SENTINEL_SCHEMA_VERSION) return undefined;

  const ageMs = now - parsed.data.blocked_at;
  const ttlMs = SENTINEL_TTL_SECONDS * 1000;
  // A clock that went backwards leaves a negative age. It is treated as expired
  // rather than as blocked forever, which is the same direction `store.ts` reads
  // a negative entry age in. The upper bound is exclusive, so a sentinel is live
  // for exactly fifteen minutes and never has zero seconds left while live.
  const live = ageMs >= 0 && ageMs < ttlMs;
  return { ageMs, live, remainingMs: live ? ttlMs - ageMs : 0 };
};

/**
 * The refusal a remembered block produces. ADR-0010 §6 reuses `code: "blocked"`
 * rather than inventing a variant, because ADR-0001's rule is that a variant
 * exists only when the caller must respond differently — and the correct
 * response to both is identical: stop, tell a human.
 *
 * The remaining life rides in the message and in `details`, never in
 * `retry_after_seconds`: `blocked` is `retry: "not_today"`, and a countdown on a
 * variant whose answer is "not today" would invite exactly the wait-and-retry
 * loop the sentinel exists to prevent. `details.source` records that this block
 * came from memory rather than from a fresh response, and per ADR-0001 nothing
 * in `details` may be branched on.
 *
 * The message names the file, because a human is one of the two things that
 * removes it (ADR-0010 §7) and cannot remove what it cannot find. The path holds
 * the token's fingerprint, which ADR-0005 §2 records as derived and not a secret.
 */
export const blockedFromMemory = (
  remainingSeconds: number,
  path: string,
): PdError =>
  pdError({
    code: "blocked",
    message:
      "Pipedrive's edge blocked this company's API traffic within the last " +
      `${SENTINEL_TTL_SECONDS / 60} minutes, so pd made no request at all. It ` +
      `will try once more in ${Math.ceil(remainingSeconds / 60)} minute(s). ` +
      "Stop using pd and tell a human; there is no flag that overrides this. " +
      `A human who must clear it early deletes ${path}.`,
    details: {
      source: "sentinel",
      remaining_seconds: remainingSeconds,
      sentinel: path,
    },
  });

export const createSentinel = ({
  clock,
  ...context
}: SentinelContext): Sentinel => {
  const directory = cacheDirFor(context);
  const path = joinerFor(context.platform)(directory, SENTINEL_FILE);

  return {
    path,

    remaining: () => {
      const reading = readSentinel(path, clock.now());
      // Unparseable, wrong shape or an unknown version: absent, and **left on
      // disk**. Deleting it would destroy the one artefact a human debugging a
      // corrupt sentinel has to look at, and `pd cache info` reports it as
      // unreadable so it is visible rather than mysterious.
      if (reading === undefined) return undefined;

      if (!reading.live) {
        // ADR-0010 §7: the sentinel is removed by the expiry and by a human. The
        // expiry is *here* because this is the only reader that acts on the
        // answer — `pd cache info` reports and changes nothing (ADR-0028 §5).
        // The unlink is best effort: losing the race to another `pd` process is
        // a file that is already gone.
        removeFile(path);
        return undefined;
      }

      return Math.ceil(reading.remainingMs / 1000);
    },

    record: () => {
      const body = JSON.stringify({
        version: SENTINEL_SCHEMA_VERSION,
        blocked_at: clock.now(),
      });
      const join = joinerFor(context.platform);
      const temporary = join(directory, temporaryName("blocked"));

      if (makeDirectory(directory).isErr()) return;
      if (writeAtomically(path, temporary, body).isErr()) removeFile(temporary);
    },
  };
};
