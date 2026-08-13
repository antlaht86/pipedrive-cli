/**
 * `pd auth status` — ADR-0012 §5.
 *
 * The only auth command. There is no `login`, no `logout`, no `verify` and no
 * `--show-token`. It makes **zero network requests** and writes nothing: its job
 * is to describe the configuration, not to use it.
 *
 * **Finding no credential is not a failure.** It exits 0 and reports the absence
 * in `found`, because a diagnostic that exits non-zero when the thing it
 * diagnoses is the problem is useless for diagnosing. ADR-0012 §7's `auth` /
 * exit 1 applies to every command that needs a credential, which this one does
 * not.
 *
 * The one thing that *is* an error here is a `--token-file` that holds no token:
 * that is a mistyped argument rather than a configuration to describe, and
 * `resolveCredential` refuses it as `usage`.
 *
 * Output is **one JSON object**, not an NDJSON stream — the same exception
 * ADR-0009 §7 grants `pd manifest`, on the same grounds: it is not a record
 * stream, it cannot be partial, and there is nothing for a trailer to say about
 * it.
 */

import { existsSync } from "node:fs";

import { err, ok, type Result } from "neverthrow";

import type { PdError } from "../errors.ts";
import type { PdWarning } from "../warnings.ts";
import {
  resolveCredential,
  windowsPermissionCaveat,
  type CredentialTier,
  type ResolveInput,
} from "./credentials.ts";
import { cacheDirFor } from "./paths.ts";

export type AuthStatus = {
  found: boolean;
  /** Absent when no credential was found. */
  tier?: CredentialTier;
  /** Absent for the `env` tier, which has no file, and when nothing was found. */
  path?: string;
  /** Absent when no credential was found. */
  fingerprint?: string;
  cache_dir_exists: boolean;
  /**
   * A constant `true` whenever a credential is found. It is a statement about
   * the mechanism, not about the token: the `api_key` scheme carries no scopes,
   * so the same token authorises `DELETE /deals/{id}` exactly as it authorises
   * `GET /deals`. `pd`'s read-only property rests entirely on `pd`'s own code
   * (ADR-0012 §2), and this field is where that is said out loud, every run.
   */
  credential_is_write_capable: boolean;
  warnings: PdWarning[];
};

export type AuthStatusInput = ResolveInput & {
  /**
   * The directory-existence check, injected for the same reason as `readFile`:
   * `%LOCALAPPDATA%\pd\<fp>` is not a path a POSIX host can hold. Production
   * never passes it.
   */
  dirExists?: (path: string) => boolean;
};

export const authStatus = (
  input: AuthStatusInput,
): Result<AuthStatus, PdError> => {
  const { dirExists = existsSync, ...resolveInput } = input;
  const resolved = resolveCredential(resolveInput);

  if (resolved.isErr()) {
    // A `usage` refusal of `--token-file` is a real failure; `auth` — nothing
    // found in any tier — is this command's normal, zero-exit answer.
    if (resolved.error.code !== "auth") return err(resolved.error);
    return ok({
      found: false,
      cache_dir_exists: false,
      credential_is_write_capable: false,
      warnings: [],
    });
  }

  const credential = resolved.value;
  const warnings = [...credential.warnings];

  // ADR-0021 §8: `pd auth status` carries the NTFS caveat, and no other command
  // does. It is about a file, so the `env` tier does not get it.
  if (input.platform === "win32" && credential.path !== undefined) {
    warnings.push(windowsPermissionCaveat(credential.path));
  }

  return ok({
    found: true,
    tier: credential.tier,
    ...(credential.path === undefined ? {} : { path: credential.path }),
    fingerprint: credential.fingerprint,
    cache_dir_exists: dirExists(
      cacheDirFor({ ...resolveInput, fingerprint: credential.fingerprint }),
    ),
    credential_is_write_capable: true,
    warnings,
  });
};
