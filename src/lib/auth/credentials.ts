/**
 * Credential resolution — ADR-0012 §3, §7.
 *
 * Every command that needs a token resolves it here. The chain has three tiers
 * and the first match wins:
 *
 *   1. `--token-file <path>` — explicit, per-invocation
 *   2. `PD_API_TOKEN` — the container, CI and agent-harness path
 *   3. the credentials file in the config directory, mode `0600`
 *
 * and otherwise the result is `auth`, exit 1, with a message naming every tier.
 * The environment sits above the file deliberately: a stored credential
 * silently beating an explicitly exported one runs commands against the wrong
 * account.
 *
 * **`pd` never writes a credential.** Nothing here creates, updates or deletes
 * a file. There is no `--token <value>` flag in any form, because argv is
 * readable by every other user on the machine.
 *
 * The token string lives only in the returned `Credential` and, from ticket 04,
 * in the one client module that puts it in the `x-api-token` header. Nothing
 * else holds it, and no code path prints it — `fingerprintOf` is the only
 * derived value that leaves this module for a human to read.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { err, fromThrowable, ok, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { PdWarning } from "../warnings.ts";
import { credentialsPath, type PathContext } from "./paths.ts";

export type CredentialTier = "token-file" | "env" | "config-file";

export type Credential = {
  tier: CredentialTier;
  /** The file the token came from; absent for the `env` tier. */
  path?: string;
  token: string;
  /** First 16 hex of SHA-256 of the token — ADR-0012 §5, ADR-0005 §2. */
  fingerprint: string;
  /** Non-fatal observations about the credential; the run continues. */
  warnings: PdWarning[];
};

export type ResolveInput = PathContext & {
  /** The value of `--token-file`, when the flag was given. */
  tokenFile?: string;
  /**
   * The filesystem read, injected on the same grounds as `platform` and `env`:
   * the Windows branch builds `%APPDATA%\pd\credentials`, which no POSIX host
   * can hold, so the Windows tiers are only reachable from a POSIX developer
   * machine through a substituted reader. Production never passes it.
   */
  readFile?: (path: string) => FileRead | undefined;
};

/**
 * The cache directory name and the `pd auth status` fingerprint are the same
 * value, so a human can match a running configuration to a cache directory
 * without `pd` printing anything reversible.
 */
export const fingerprintOf = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

/** A credential file's contents and its POSIX mode bits. */
export type FileRead = { text: string; mode: number };

/**
 * `node:fs` throws, so it is wrapped here rather than caught. Every reason a
 * file cannot be read collapses to the same answer, because the distinction is
 * not actionable: a human must go and place a token either way.
 */
const statFile = fromThrowable((path: string) => statSync(path));
const readFileText = fromThrowable((path: string) => readFileSync(path, "utf8"));

/** Reads a file for its contents and its mode. Absent or unreadable is `undefined`. */
const readCredentialFile = (path: string): FileRead | undefined =>
  statFile(path)
    .andThen((stats) =>
      stats.isFile()
        ? readFileText(path).map((text) => ({ text, mode: stats.mode }))
        : err(undefined),
    )
    .unwrapOr(undefined);

/**
 * A credential file is external input, so the token is parsed rather than
 * assumed: surrounding whitespace is removed, and what remains must be
 * non-empty. Nothing more can be checked — no store-time validation exists
 * (ADR-0012 §6), so a well-formed but wrong token is only discovered by the
 * first real request.
 */
const TOKEN = z
  .string()
  .transform((raw) => raw.trim())
  .pipe(z.string().min(1));

/** The token a file or an environment variable holds, or `undefined` for neither. */
const tokenOf = (raw: string | undefined): string | undefined => {
  const parsed = TOKEN.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

const looseMode = (mode: number): boolean => (mode & 0o077) !== 0;

/**
 * ADR-0012 §3: the token is already exposed and refusing to run does not
 * unexpose it, so this is a `warning` and the run continues. It applies to both
 * file tiers — `--token-file` names a file a human wrote in exactly the same
 * way tier 3 does.
 *
 * Windows is silent here: `0600` has no NTFS equivalent, so the mode bits
 * `statSync` reports are not a fact about who can read the file. ADR-0021 §8
 * puts that gap in `pd auth status`'s `warnings` instead, and in no other
 * command — see `windowsPermissionCaveat`.
 */
const permissionWarning = (
  platform: PathContext["platform"],
  path: string,
  read: FileRead,
): PdWarning | undefined => {
  if (platform === "win32") return undefined;
  if (!looseMode(read.mode)) return undefined;
  const mode = `0${(read.mode & 0o777).toString(8).padStart(3, "0")}`;
  return {
    kind: "credential_file_permissions",
    path,
    mode,
    message:
      `The credential file ${path} has mode ${mode}; other users on this ` +
      `machine can read the token. Restrict it with: chmod 600 ${path}`,
  };
};

/**
 * ADR-0021 §8. `pd auth status` states the NTFS gap rather than papering over
 * it. It is a standing platform fact rather than something observed about this
 * file, so it is built here and emitted only by the status command.
 */
export const windowsPermissionCaveat = (path: string): PdWarning => ({
  kind: "credential_file_permissions",
  path,
  message:
    `The credential file ${path} is on Windows, where mode 0600 has no NTFS ` +
    `equivalent and pd cannot check who can read it. Confirm the file's ` +
    `permissions yourself.`,
});

const credential = (
  tier: CredentialTier,
  token: string,
  path: string | undefined,
  warnings: PdWarning[],
): Credential => ({
  tier,
  ...(path === undefined ? {} : { path }),
  token,
  fingerprint: fingerprintOf(token),
  warnings,
});

/**
 * An explicit `--token-file` that yields no token is `usage`, exit 2 — not
 * `auth`, and never a silent fall-through to a lower tier.
 *
 * Falling through would be the wrong-account astonishment the tier order exists
 * to prevent: a mistyped path would quietly run against whatever `PD_API_TOKEN`
 * happens to hold. `usage` rather than `auth` because ADR-0012 §7's argument for
 * `auth` — "no argument the caller can supply produces a credential" — does not
 * hold here: fixing the path argument does. Echoing the path back is allowed by
 * ADR-0012 §3, since no argument value `pd` accepts is sensitive.
 */
const tokenFileRefusal = (path: string): PdError =>
  pdError({
    code: "usage",
    message:
      `--token-file ${path} holds no token. pd reads the whole file and trims ` +
      `surrounding whitespace; the file must exist and must not be empty. pd ` +
      `never falls back to another tier when --token-file is given.`,
  });

const notFound = (configPath: string): PdError =>
  pdError({
    code: "auth",
    message:
      `No Pipedrive API token found. pd searched, in order: --token-file (not ` +
      `given), the PD_API_TOKEN environment variable (not set), and the ` +
      `credentials file ${configPath} (absent or empty). Create that file with ` +
      `mode 0600 containing the token, or export PD_API_TOKEN. pd never writes ` +
      `a credential itself.`,
  });

export const resolveCredential = (
  input: ResolveInput,
): Result<Credential, PdError> => {
  const { tokenFile, readFile = readCredentialFile, ...context } = input;

  if (tokenFile !== undefined) {
    const read = readFile(tokenFile);
    const token = tokenOf(read?.text);
    if (read === undefined || token === undefined) {
      return err(tokenFileRefusal(tokenFile));
    }
    const warning = permissionWarning(context.platform, tokenFile, read);
    return ok(
      credential("token-file", token, tokenFile, warning ? [warning] : []),
    );
  }

  // A whitespace-only `PD_API_TOKEN` is treated as unset, on the same rule the
  // file tiers use: a variable exported to the empty string is what an unset
  // variable looks like in a shell script that meant to skip it.
  const fromEnv = tokenOf(context.env["PD_API_TOKEN"]);
  if (fromEnv !== undefined) {
    return ok(credential("env", fromEnv, undefined, []));
  }

  const configPath = credentialsPath(context);
  const read = readFile(configPath);
  const token = tokenOf(read?.text);
  if (read !== undefined && token !== undefined) {
    const warning = permissionWarning(context.platform, configPath, read);
    return ok(
      credential("config-file", token, configPath, warning ? [warning] : []),
    );
  }

  return err(notFound(configPath));
};
