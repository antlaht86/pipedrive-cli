# Storing API credentials safely for a local CLI

Type: research
Status: resolved

## Question

Where can a locally-installed CLI keep a Pipedrive credential so the user supplies it once, not on every invocation, without leaving it lying around in plaintext?

- The OS keychain path: macOS Keychain, Linux Secret Service or libsecret, Windows Credential Manager. What Bun can reach — native bindings, a bundled dependency, or shelling out to `security` and friends — and what breaks on a headless machine, over SSH, or in CI where no keychain daemon runs.
- The config-file path: conventional location (`XDG_CONFIG_HOME`, `~/.config/pd`, `~/.pd`), file permission expectations, and what other CLIs in this space actually do. Whether encryption at rest without a keychain is meaningful or merely theatre.
- The environment-variable path: what it costs in leakage — process listings, shell history, exported subprocess environments, CI logs — and whether it should nonetheless be supported as the CI and container escape hatch.
- Precedence between the three, and how a credential is discovered when more than one is present.
- Multiple credentials: how comparable CLIs model named profiles or accounts, and how the active one is selected and switched.
- Leakage surfaces specific to this tool: whether a credential can appear in a diagnostic on stderr, in a cache file on disk, in a cache key, or in a `--pretty` dump. What redaction other tools apply.
- Whether the credential can be validated cheaply at store time so a bad paste fails immediately rather than on first use.

The user's constraint is explicit: the credential must not be re-entered on every invocation. Establish the options and their real failure modes; the choice is made in the auth decision ticket.

## Answer

Findings: [research/08-secure-credential-storage.md](../research/08-secure-credential-storage.md), with a recommended precedence chain in its section 7.

**`Bun.secrets` is built in — the keychain path needs no npm package.** It talks to macOS Keychain Services, libsecret on Linux and Windows Credential Manager directly.

**But the keychain can never be the only path, and it must never hang.** Tested in `oven/bun:1`: a stock container throws in 3 ms with `code: "ERR_SECRETS_PLATFORM_ERROR"` ("libsecret not available"); with libsecret installed but no D-Bus daemon it throws in 6 ms. Both fail fast and are distinguishable by that one stable code. `typeof Bun.secrets` stays `"object"` in both cases, so feature detection is useless — you must call and catch. SSH sessions and CI runners are further distinct failure modes, and a locked macOS keychain over SSH may block rather than degrade.

**Recommended precedence, first match wins**: `--token-file <path>` (never a `--token <value>` flag — argv is world-readable), then `PD_API_TOKEN`, then the keychain via `Bun.secrets` keyed by profile, then a `0600` plaintext file under `$XDG_CONFIG_HOME/pd/`, then fail. The env var sits **above** the keychain because every surveyed CLI does it that way and because the reverse is astonishing — a stored credential silently beating an explicitly exported one runs commands against the wrong account.

**Named profiles** follow AWS and Stripe: a `--profile` flag plus `PD_PROFILE`, defaulting to `default`. The profile name is both the `Bun.secrets` key and the config-file section, so one selector drives both backends — and it must also key the custom-field cache, since field hashes are per-account.

**Store-time validation is cheap and worth it**: `GET /users/me` costs 2 API points and returns the bound company id and domain, turning a mistyped paste into an immediate error. Validate on login, never on every invocation.
