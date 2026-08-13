# 03 — Credential resolution and `pd auth status`

**What to build:** An operator runs `pd auth status` and gets one JSON object naming which credential tier is in play, its fingerprint, whether the cache directory exists, and — every single run — the statement that the token is write-capable. The command makes zero HTTP requests and writes nothing to disk. With no credential found it still exits 0.

Every later command resolves its token through this same chain.

**Blocked by:** 01

**Status:** ready-for-agent

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

- [ ] The four-tier precedence resolves correctly, first match wins, on both POSIX and Windows paths
- [ ] No credential anywhere produces `auth`, exit 1, with a message naming every tier searched
- [ ] `pd auth status` emits one JSON object with `found`, `tier`, file path where applicable, `fingerprint`, `cache_dir_exists`, `credential_is_write_capable`, `warnings`
- [ ] `pd auth status` makes zero HTTP requests and writes zero files, asserted by dispatch count
- [ ] `pd auth status` with no credential found exits 0
- [ ] A credential file with loose permissions emits one `warning` line and the run continues
- [ ] The new eighth warning kind is named and documented alongside the other seven
- [ ] No `--token <value>` flag exists in any form
