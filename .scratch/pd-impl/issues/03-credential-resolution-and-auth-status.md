# 03 — Credential resolution and `pd auth status`

**What to build:** An operator runs `pd auth status` and gets one JSON object naming which credential tier is in play, its fingerprint, whether the cache directory exists, and — every single run — the statement that the token is write-capable. The command makes zero HTTP requests and writes nothing to disk. With no credential found it still exits 0.

Every later command resolves its token through this same chain.

**Blocked by:** 01

**Status:** done

Normative: ADR-0012 (authentication and credential resolution), [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) §8 (Windows paths — the mapping ADR-0014 §6 defined, unchanged).

*Note: the built binary must not pick up a `.env` from the process CWD — that is ticket 01's build flags, and this ticket's `env` tier assumes it. The CI gate asserting it drives `pd auth status`, so the two meet here.*

Notes for the implementer:

- API token in the `x-api-token` header. **No OAuth, ever** — Pipedrive offers Authorization Code flow only, which would require every user to register a Marketplace application.
- Precedence, first match wins: `--token-file <path>`, then `PD_API_TOKEN`, then `$XDG_CONFIG_HOME/pd/credentials` (default `~/.config/pd/credentials`, mode `0600`, `%APPDATA%\pd\` on Windows). Otherwise the error is `auth`, exit 1, with a message naming **every** tier searched.
- **No `--token <value>` flag in any form** — argv is world-readable. A consequence worth relying on: no argument value `pd` accepts is sensitive, so usage errors may echo the offending argument back.
- **`pd` never writes a credential.** No `login`, no `logout`, no keychain tier, no `Bun.secrets`. Tier 3 is a file a human writes with an editor.
- **No named profiles**, no `--profile`, no `PD_PROFILE`.
- **No store-time validation.** `GET /users/me` stays out of the generated surface; a bad token surfaces as `auth` on the first real command.
- `fingerprint` is the first 16 hex of SHA-256 of the resolved token — the same value the cache directory uses later (ticket 08).
- `credential_is_write_capable` is a constant `true` whenever a credential is found. It is a statement about the mechanism, not about the token.
- Loose file permissions produce one `warning` and the run **continues** — refusing does not undo the exposure. On Windows the NTFS permission gap is stated in the `warnings` array rather than papered over.
- **An eighth `warning` kind must be minted here.** ADR-0012 §3's loose-permissions warning is a machine-mode stdout `warning` line, so ADR-0006 §6 requires it to carry a `kind`, and no ADR names one. Pick a name, record it, and it joins the seven existing kinds. Adding it is additive and non-breaking.

- [x] The four-tier precedence resolves correctly, first match wins, on both POSIX and Windows paths
- [x] No credential anywhere produces `auth`, exit 1, with a message naming every tier searched
- [x] `pd auth status` emits one JSON object with `found`, `tier`, file path where applicable, `fingerprint`, `cache_dir_exists`, `credential_is_write_capable`, `warnings`
- [x] `pd auth status` makes zero HTTP requests and writes zero files — *asserted, but by a throwing
  `globalThis.fetch` and a before/after directory snapshot; the dispatch count is ticket 04's seam and
  the assertion migrates there*
- [x] `pd auth status` with no credential found exits 0
- [x] A credential file with loose permissions emits one `warning` line and the run continues
- [x] The new eighth warning kind is named and documented alongside the other seven
- [x] No `--token <value>` flag exists in any form

## Comments

**2026-08-13 — handoff from ticket 01.** The CWD autoload gate (ADR-0021 §3, ADR-0019 §8) currently
asserts against a **probe** binary in `test/dotenv-autoload.test.ts`, because no command reads the
credential chain yet. This ticket promotes the `.env` half to the normative form: run `pd auth status`
from a directory holding a `.env` that sets `PD_API_TOKEN`, against `dist/pd`, in the binary smoke legs
of `.github/workflows/ci.yml`, and assert the run does not report the `env` tier. Both compile through
`buildBinary` in `scripts/build.ts`, the single build path.

**2026-08-13 — implemented.**

- `src/lib/auth/paths.ts` owns the two per-user directories, with `platform`, `env` and `home` as
  parameters rather than reads of the ambient process. Both mappings of ADR-0021 §8 are therefore
  asserted from every machine, and the Windows CI leg re-checks the same code against the real
  filesystem.
- `src/lib/auth/credentials.ts` owns the chain and is what every later command calls.
  `src/lib/auth/status.ts` owns the command. `src/lib/errors.ts` carries ADR-0001's static table —
  one row of `{ exit, retry }` per variant — plus the object constructor, and nothing else; the
  NDJSON trailer belongs to ticket 05's writer.
- **The eighth `warning` kind is `credential_file_permissions`.** One kind covers both permission
  statements about the credential file: ADR-0012 §3's POSIX mode looser than `0600`, and ADR-0021
  §8's Windows NTFS gap. They say the same thing about the same file. `src/lib/warnings.ts` is the
  registry; the spec's list and `CONTEXT.md` are copies of it. ADR-0021 §8's "no other command
  carries it" is honoured by building the NTFS caveat outside the resolver — `windowsPermissionCaveat`
  is exported and only `status.ts` calls it, while the POSIX loose-mode warning rides on the
  `Credential` every command receives.
- **An invented contract point, recorded because no ADR settles it.** A `--token-file` naming a file
  that does not exist, cannot be read, or holds only whitespace is `usage`, exit 2 — and it never
  falls through to `PD_API_TOKEN`. Falling through would be exactly the wrong-account astonishment
  the tier order exists to prevent. `usage` rather than `auth` because ADR-0012 §7's argument for
  `auth` ("no argument the caller can supply produces a credential") does not hold here: fixing the
  path argument does, which is what exit 2 tells an agent to try. The path is echoed back, which
  ADR-0012 §3 permits. A tier-3 file that is empty is *not* this case — it falls through to
  not-found-anywhere and is `auth`, exit 1, as the ADR requires.
- The permission warning covers both file tiers. `--token-file` names a file a human wrote in the
  same way tier 3 does, and the exposure is identical.
- `resolveCredential` takes an optional `readFile`, and `authStatus` an optional `dirExists`.
  Production passes neither. They exist because `%APPDATA%\pd\credentials` is not a path a POSIX
  host can hold, so the Windows tiers are otherwise unreachable from a developer machine. They are
  function parameters, not the test-only flags or environment variables the spec refuses.
- **For ticket 04.** "Zero HTTP requests" is asserted today by installing a `globalThis.fetch` that
  throws, in `src/lib/auth/status.test.ts`. That is the honest interim form: the spec's single answer
  to every "and no request was made" question is `guardedFetch`'s dispatch count, and the seam does
  not exist yet. Migrate the assertion when it does.
- **For ticket 19.** `AGENTS.md` owes ADR-0012's list: the three tiers in order, `PD_API_TOKEN`,
  `~/.config/pd/credentials` at mode `0600`, the `auth`/exit 1 contract, `pd auth status`, and the
  honest paragraph about the write-capable token. The `--token-file` refusal above should be named
  there too.
- The CWD `.env` gate is now normative on both binary CI legs: `pd auth status` beside a `.env`
  setting `PD_API_TOKEN`, against `dist/pd`, asserting `found:false` and no `tier`.
  `test/dotenv-autoload.test.ts` keeps the probe, because no `pd` command reveals a `bunfig.toml`
  preload and that half of the gate has no other home.
- The argument parsing in `src/cli.ts` is deliberately the smallest thing that serves one command,
  not the beginning of ticket 16's table. It refuses `--token` and `--token=…` explicitly, with the
  reason, rather than letting them fall into a generic unknown-flag error.

**2026-08-13 — after review.**

- `readCredentialFile` was a raw `try`/`catch`; it is now `fromThrowable` around `statSync` and
  `readFileSync`, which is the form CLAUDE.md prescribes for a third-party throw at a boundary.
- The token is now parsed with zod at all three boundaries — the two files and `PD_API_TOKEN` — by
  one `TOKEN` schema, rather than three hand-written trims. It is the only check available: ADR-0012
  §6 refuses store-time validation, so a well-formed but wrong token is only discovered by the first
  real request.
- **A whitespace-only `PD_API_TOKEN` is unset.** No ADR settles it. A variable exported to the empty
  string is what an unset variable looks like in a shell script that meant to skip it, and the file
  tiers already treat an empty file the same way.
- `src/lib/errors.ts` now holds one table of `{ exit, retry }` per variant rather than two parallel
  `Record`s that had to be edited together.
- `paths.ts` branches on the platform once, in `separator`, instead of three times; the two mappings
  now differ only in their root variable and their fallback.
- **`--pretty` is deferred to ticket 18, deliberately.** ADR-0012 §5 says "`--pretty` renders the
  same fields as human text", and today `pd auth status --pretty` is a `usage` refusal. ADR-0018's
  aligned-table renderer, the flag's registration and the "an agent must never invoke it" contract
  all belong to that ticket, and building a one-off human renderer here would be a second
  implementation to delete. Ticket 18 must add `pd auth status` to its list of surfaces.
- **The `--token-file` refusal was challenged in review and stands.** The objection is that ADR-0012
  §5's "finding no credential is not a failure of `pd auth status`" makes
  `pd auth status --token-file /typo` exiting 2 a deviation. It reads as a statement about the
  *chain* coming up empty, which is the configuration the command exists to describe; a mistyped path
  is not a configuration. The alternative — falling through to `PD_API_TOKEN` — reports a tier the
  operator did not ask for, which is the wrong-account astonishment §3's tier order exists to
  prevent. Reopen it under ADR-0012 if the reading is wrong; do not change it silently.
- **Zod on argv is deferred to ticket 16, not overlooked.** The review flagged the argument loop in
  `src/cli.ts` as the boundary where "parse external input at the boundary" bites hardest. That loop
  is a placeholder for one command; ticket 16 builds the command table and the manifest generated
  from it, and the schema belongs there, once, rather than twice.
