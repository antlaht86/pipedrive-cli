/**
 * `pd cache info` and `pd cache clear` — ADR-0005 §7, ADR-0009 §8, ADR-0010 §7.
 *
 * Both sit outside the resource grammar: `cache` is not a Pipedrive resource and
 * `info` and `clear` are not `list` or `get`. Like `pd manifest` and `pd auth
 * status` they emit **one JSON object**, not NDJSON — neither is a record
 * stream, neither can be partial, and neither has anything for a trailer to
 * report.
 *
 * ## Neither resolves a credential
 *
 * The cache directory is keyed by the credential's hash, but these two commands
 * take the **root** of that subtree, which ADR-0005 §7 calls a constant. A human
 * running `pd cache info` is very often a human whose credential is exactly what
 * is broken, and a `clear` that first demanded a token would be unavailable
 * precisely when it is wanted. `info` therefore reports every credential's
 * directory, labelled by the same fingerprint `pd auth status` prints.
 *
 * ## Both perform zero HTTP requests, and `clear` spares one file
 *
 * ADR-0010 §7: an agent that meets an error and tries "clear the cache and
 * retry" is exercising an entirely ordinary recovery reflex, and if that deleted
 * the `blocked` sentinel it would walk straight back into a company-wide block.
 * `clear`'s target is the subtree **minus** that file, and `info` reports the
 * sentinel's presence and age because a human debugging a refusal that made no
 * requests has no other way to see it.
 *
 * Read-only is a property of what `pd` does to the Pipedrive API. Deleting local
 * files is not a violation of it (ADR-0005 §7).
 */

import { readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";

import { fromThrowable } from "neverthrow";

import { pdError, type PdError } from "../lib/errors.ts";
import { cacheRootDir, joinerFor, type PathContext } from "../lib/auth/paths.ts";
import {
  CACHE_ENTRY_NAMES,
  CACHE_SCHEMA_VERSION,
  SENTINEL_FILE,
  StoredEntry,
  TTL_SECONDS,
  entryFileName,
  type CacheEntryName,
} from "../lib/cache/entries.ts";
import { systemClock, type Clock } from "../lib/pipedrive/clock.ts";
import { failWith, type Sink } from "../lib/output/ndjson-writer.ts";

export type CacheVerb = "info" | "clear";

export const CACHE_VERBS: readonly CacheVerb[] = ["info", "clear"];

export const isCacheVerb = (value: string | undefined): value is CacheVerb =>
  value !== undefined && (CACHE_VERBS as readonly string[]).includes(value);

export type CacheCommandInput = {
  verb: CacheVerb;
  /** Everything after `pd cache <verb>`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  clock?: Clock;
  sink?: Sink;
  stderr?: Sink;
};

const listDirectory = fromThrowable((path: string) =>
  readdirSync(path, { withFileTypes: true }),
);
const readText = fromThrowable((path: string) => readFileSync(path, "utf8"));
const modifiedAt = fromThrowable((path: string) => statSync(path).mtimeMs);
const removeFile = fromThrowable((path: string): void => {
  unlinkSync(path);
});
const removeDirectory = fromThrowable((path: string): void => {
  rmdirSync(path);
});

const seconds = (milliseconds: number): number =>
  Math.max(0, Math.round(milliseconds / 1000));

const BY_FILE_NAME = new Map<string, CacheEntryName>(
  CACHE_ENTRY_NAMES.map((name) => [entryFileName(name), name]),
);

type EntryReport = {
  /** The token fingerprint, the same value `pd auth status` reports. */
  credential: string;
  entry: CacheEntryName;
  ttl_seconds: number;
  /** Absent when the entry could not be read — see `readable`. */
  age_seconds?: number;
  /** Absent when the age is unknown. */
  stale?: boolean;
  /** Present and `false` only for an entry `pd` would skip and refetch. */
  readable?: false;
};

const parseJson = fromThrowable((text: string): unknown => JSON.parse(text));

/**
 * `undefined` for every entry `pd` itself would not use — unreadable, not JSON,
 * or stamped with a version this binary does not recognise. The report says
 * `readable: false` rather than guessing an age, because an age is the one
 * thing a human runs this command to learn.
 */
const ageOf = (path: string, now: number): number | undefined => {
  const body = readText(path).andThen(parseJson);
  if (body.isErr()) return undefined;
  // The same schema the store reads an entry with, so this command cannot
  // report an age for a file `pd` itself would refuse.
  const entry = StoredEntry.safeParse(body.value);
  return entry.success && entry.data.version === CACHE_SCHEMA_VERSION
    ? seconds(now - entry.data.fetched_at)
    : undefined;
};

const info = (
  root: string,
  join: (...parts: string[]) => string,
  now: number,
): Record<string, unknown> => {
  const entries: EntryReport[] = [];
  const blocked: { credential: string; age_seconds: number }[] = [];

  for (const directory of listDirectory(root).unwrapOr([])) {
    if (!directory.isDirectory()) continue;
    const credential = directory.name;
    const path = join(root, credential);

    for (const file of listDirectory(path).unwrapOr([])) {
      if (!file.isFile()) continue;

      if (file.name === SENTINEL_FILE) {
        const modified = modifiedAt(join(path, file.name)).unwrapOr(now);
        blocked.push({ credential, age_seconds: seconds(now - modified) });
        continue;
      }

      const entry = BY_FILE_NAME.get(file.name);
      if (entry === undefined) continue;

      const age = ageOf(join(path, file.name), now);
      entries.push({
        credential,
        entry,
        ttl_seconds: TTL_SECONDS[entry],
        ...(age === undefined
          ? { readable: false as const }
          : { age_seconds: age, stale: age > TTL_SECONDS[entry] }),
      });
    }
  }

  return { path: root, entries, blocked };
};

const clear = (
  root: string,
  join: (...parts: string[]) => string,
): Record<string, unknown> => {
  let removed = 0;
  let preserved = 0;

  for (const directory of listDirectory(root).unwrapOr([])) {
    if (!directory.isDirectory()) continue;
    const path = join(root, directory.name);

    for (const file of listDirectory(path).unwrapOr([])) {
      if (!file.isFile()) continue;
      if (file.name === SENTINEL_FILE) {
        preserved += 1;
        continue;
      }
      if (removeFile(join(path, file.name)).isOk()) removed += 1;
    }

    // An emptied directory is removed too; one holding the sentinel stays. The
    // failure is ignored on purpose — a directory that will not go away is not
    // a reason to report a cleared cache as an error.
    removeDirectory(path);
  }

  return { path: root, removed, preserved };
};

/**
 * ADR-0005 §7: `clear` takes **no path argument, no pattern and no widening
 * flag**, and `info` takes none either. The refusal names that rather than
 * naming the argument, because the answer to "which flag should I pass" is that
 * there is no flag to pass.
 */
const refusal = (command: string, argument: string): PdError =>
  pdError({
    code: "usage",
    message:
      `${command} takes no arguments and no flags; got ${argument}. Its target ` +
      "is a constant: the whole pd cache directory.",
  });

export const cacheCommand = ({
  verb,
  argv,
  platform,
  env,
  home,
  clock = systemClock,
  sink,
  stderr,
}: CacheCommandInput): number => {
  const out = sink ?? ((line: string) => process.stdout.write(line));
  const error = stderr ?? ((line: string) => process.stderr.write(line));
  const command = `pd cache ${verb}`;

  const extra = argv[0];
  if (extra !== undefined) return failWith(refusal(command, extra), out, error);

  const context: PathContext = { platform, env, home };
  const root = cacheRootDir(context);
  const join = joinerFor(platform);

  const report =
    verb === "info" ? info(root, join, clock.now()) : clear(root, join);
  out(`${JSON.stringify(report)}\n`);
  return 0;
};
