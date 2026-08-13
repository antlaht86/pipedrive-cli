/**
 * The on-disk cache — ADR-0005 §2, §5, §6, §8.
 *
 * One credential's directory, `<cache root>/<token-hash>/`, holding at most the
 * eight files `entries.ts` names. A file holds the **raw** records exactly as
 * Pipedrive returned them, before any record schema ran: ADR-0005 §5 requires
 * that cached data be validated on read against the same schema a fresh fetch is
 * validated against, and the only way that can be true is if the disk holds what
 * the wire held. A cache that stored parsed records would quietly become the
 * definition of what `pd` accepts.
 *
 * ## Nothing here is fatal
 *
 * Every failure — an unreadable directory, half a file, a JSON syntax error, an
 * unwritable disk — is a `PdWarning` or a miss, never a `PdError`. ADR-0005 §5:
 * cache corruption is not an error variant, `pd` evicts and refetches. The one
 * behaviour that is *not* a warning is a schema version the binary does not
 * recognise (§6): that is treated exactly like a missing entry, silently,
 * because an upgrade rewriting eight entries is expected rather than a signal.
 *
 * ## No credential is ever written
 *
 * Only the hash, and only as a directory name. The file holds records, a
 * version and a timestamp; `store.test.ts` greps the written bytes for the token
 * so this stays true rather than remaining an intention.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { fromThrowable } from "neverthrow";
import { z } from "zod";

import type { PdWarning } from "../warnings.ts";
import type { Clock } from "../pipedrive/clock.ts";
import { cacheDirFor, type CacheDirContext } from "../auth/paths.ts";
import {
  CACHE_SCHEMA_VERSION,
  TTL_SECONDS,
  entryFileName,
  type CacheEntryName,
} from "./entries.ts";

/**
 * The file format. `version` is read before anything else, and `records` is
 * `unknown[]` because the record schema has not run yet and must not appear to
 * have run.
 */
const StoredEntry = z.object({
  version: z.int(),
  /** Milliseconds since the epoch, from the injected clock. */
  fetched_at: z.int(),
  records: z.array(z.unknown()),
});

export type CacheRead =
  /** A live entry, within its TTL, its records as they arrived from Pipedrive. */
  | { outcome: "hit"; records: unknown[]; fetchedAt: number }
  /** Absent, expired, or stamped with a version this binary does not know. */
  | { outcome: "miss" }
  /** Present and broken. The caller emits the warning and refetches. */
  | { outcome: "skipped"; warning: PdWarning };

export type CacheStore = {
  /** The credential's directory, for `details` and for diagnostics. */
  readonly path: string;
  read: (name: CacheEntryName) => CacheRead;
  /** Returns a warning when the write failed; the run continues either way. */
  write: (name: CacheEntryName, records: readonly unknown[]) => PdWarning | undefined;
};

export type CacheStoreContext = CacheDirContext & { clock: Clock };

/**
 * ADR-0005 §5 gives every broken entry one wording, because the distinction
 * between "not JSON", "wrong shape" and "unreadable" is not actionable: the
 * outcome is the same refetch either way. `reason` rides in the warning for a
 * human, and per ADR-0006 §6 `kind` is the only field a consumer branches on.
 */
const skipped = (name: CacheEntryName, path: string, reason: string): PdWarning => ({
  kind: "cache_entry_skipped",
  entry: name,
  path,
  reason,
  message:
    `The cached ${name} entry at ${path} could not be used (${reason}); pd ` +
    "refetched it. This is not an error and the run continued.",
});

const readText = fromThrowable((path: string) => readFileSync(path, "utf8"));
const parseJson = fromThrowable((text: string): unknown => JSON.parse(text));

const write = fromThrowable(
  (path: string, temporary: string, body: string): void => {
    // ADR-0005 §6: temp file plus `rename`, so a half-written entry is never
    // observable, and `0600`, because field schemas and the user list are
    // company data. No locking: two concurrent processes write identical
    // content, the last write wins, and both readers see an intact file.
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, path);
  },
);

const remove = fromThrowable((path: string): void => {
  unlinkSync(path);
});

const makeDirectory = fromThrowable((path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
});

/** A distinct name per process, so two concurrent writers never share a temp file. */
const temporaryName = (name: CacheEntryName): string =>
  `.${name}.${process.pid}.tmp`;

export const createCacheStore = ({
  clock,
  ...context
}: CacheStoreContext): CacheStore => {
  const directory = cacheDirFor(context);
  const separator = context.platform === "win32" ? "\\" : "/";
  const join = (file: string): string => [directory, file].join(separator);

  return {
    path: directory,

    read: (name) => {
      const path = join(entryFileName(name));
      const text = readText(path);
      // Absent is the ordinary cold-cache case and says nothing worth saying.
      if (text.isErr()) return { outcome: "miss" };

      const body = parseJson(text.value);
      if (body.isErr()) {
        return { outcome: "skipped", warning: skipped(name, path, "it is not JSON") };
      }

      const entry = StoredEntry.safeParse(body.value);
      if (!entry.success) {
        return {
          outcome: "skipped",
          warning: skipped(name, path, "its contents are not a cache entry"),
        };
      }
      // ADR-0005 §6, and the ticket: an unrecognised version reads as missing.
      if (entry.data.version !== CACHE_SCHEMA_VERSION) return { outcome: "miss" };

      const age = clock.now() - entry.data.fetched_at;
      // A clock that went backwards — a corrected NTP offset, a restored
      // machine — leaves a negative age. It is treated as expired rather than
      // as fresh forever, which is the direction ADR-0005's whole argument
      // about stale answers points in.
      if (age < 0 || age > TTL_SECONDS[name] * 1000) return { outcome: "miss" };

      return {
        outcome: "hit",
        records: entry.data.records,
        fetchedAt: entry.data.fetched_at,
      };
    },

    write: (name, records) => {
      const path = join(entryFileName(name));
      const temporary = join(temporaryName(name));
      const body = JSON.stringify({
        version: CACHE_SCHEMA_VERSION,
        fetched_at: clock.now(),
        records,
      });

      const made = makeDirectory(directory);
      if (made.isErr()) {
        return skipped(name, path, "its directory could not be created");
      }

      const written = write(path, temporary, body);
      if (written.isErr()) {
        // A rename that failed leaves the temp file behind; a read-only
        // filesystem leaves nothing. Both are best-effort cleanups.
        remove(temporary);
        return skipped(name, path, "it could not be written");
      }
      return undefined;
    },
  };
};
