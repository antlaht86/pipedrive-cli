/**
 * The filesystem primitives both files under a credential's directory need —
 * ADR-0005 §6's on-disk mechanics, which ADR-0010's consequences hand to the
 * `blocked` sentinel unchanged.
 *
 * `store.ts` and `sentinel.ts` are deliberately separate modules: ADR-0028 §1
 * keeps the sentinel out of `CacheStore` because that store is keyed by the
 * closed `CacheEntryName` union and is built by one command, while a blocked
 * `pd deals list` must record the block just the same. That argument is about
 * the store's *surface*. It says nothing about the temp-file-plus-`rename` and
 * the `0600`, which are one decision and are therefore written once here — a
 * second copy is the one that would be the day someone fixed the first.
 *
 * Every function is a `fromThrowable` wrapper: `CLAUDE.md` puts third-party
 * throws at the boundary and this file is that boundary for `node:fs`.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { fromThrowable } from "neverthrow";

/**
 * The error is the `errno` code, because the one distinction either caller draws
 * is `ENOENT` — an absent file is the ordinary cold case and says nothing worth
 * saying, while a file that exists and cannot be read is ADR-0005 §5's "an I/O
 * error, wrong permissions".
 */
export const readText = fromThrowable(
  (path: string) => readFileSync(path, "utf8"),
  (cause) => (cause as { code?: string } | null)?.code,
);

export const parseJson = fromThrowable((text: string): unknown => JSON.parse(text));

/**
 * Temp file plus `rename`, so a half-written file is never observable, and
 * `0600`, because field schemas and the user list are company data and the
 * directory name is derived from a credential. No locking: two concurrent
 * processes write identical content, the last write wins, and both readers see
 * an intact file.
 */
export const writeAtomically = fromThrowable(
  (path: string, temporary: string, body: string): void => {
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, path);
  },
);

export const removeFile = fromThrowable((path: string): void => {
  unlinkSync(path);
});

export const makeDirectory = fromThrowable((path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
});

/** A distinct name per process, so two concurrent writers never share one. */
export const temporaryName = (stem: string): string =>
  `.${stem}.${process.pid}.tmp`;
