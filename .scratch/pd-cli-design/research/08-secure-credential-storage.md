# Research: storing a Pipedrive API credential safely for `pd`

Ticket: `.scratch/pd-cli-design/issues/08-research-secure-credential-storage.md`
Date: 2026-08-11
Method: primary sources only (official OS/vendor/spec documentation, package source), plus empirical verification with Bun 1.3.14 on macOS (Darwin 24.6.0, arm64) and in a headless `oven/bun:1` Linux container.

No real credential was stored, read or printed during this research. All empirical tests used a throwaway service name and a dummy string, deleted afterwards.

---

## 1. What Bun can actually reach for OS-native credential storage

### 1.1 `Bun.secrets` — built in, no dependency

Bun ships a first-party API, `Bun.secrets`, that talks to the OS credential store directly. This is the single most important finding: **the keychain path needs no npm package at all.**

Documented backends ([bun.com/docs/api/secrets](https://bun.com/docs/api/secrets)):

| Platform | Backend |
| --- | --- |
| macOS | Keychain Services |
| Linux | libsecret (GNOME Keyring, KWallet, and other Secret Service daemons) |
| Windows | Windows Credential Manager |

API surface, per the same page:

- `Bun.secrets.set({ service, name, value }) => Promise<void>`
- `Bun.secrets.get({ service, name }) => Promise<string | null>`
- `Bun.secrets.delete({ service, name }) => Promise<boolean>`

Introduced in **Bun v1.2.21**: "`Bun.secrets` securely stores and retrieves credentials using the operating system's native credential storage. This helps avoid storing sensitive data in plaintext files which is especially useful for CLI tools and local development." ([bun.com/blog/release-notes/bun-v1.2.21](https://bun.com/blog/release-notes/bun-v1.2.21)). All operations run asynchronously in Bun's thread pool.

Documented constraints on that page: maximum password length varies by platform (typically 2048–4096 bytes); `service` and `name` should stay under 256 characters; on Linux "a secret service daemon must be running"; on macOS "the keychain may prompt for access permission on first use". Failures surface as thrown exceptions, not as a `Result`-shaped return — so under this project's `neverthrow` rule every call must be wrapped with `ResultAsync.fromPromise` at the boundary. A missing credential is *not* an error: `get()` returns `null`.

The docs also state the API is "mostly useful for local development tools" and "Not very useful for deployment secrets (use environment variables in production)". Bun's own documentation therefore endorses the env-var escape hatch for the containerised case.

**Empirically verified on this machine** (Bun 1.3.14, macOS):

```
typeof Bun.secrets            -> "object"
Object.keys(Bun.secrets)      -> [ "get", "set", "delete" ]
set/get round trip            -> value returned identical
get() on an absent name       -> null
delete()                      -> true, and the item is gone
```

The stored item is an ordinary macOS *generic password* in `~/Library/Keychains/login.keychain-db`. `security find-generic-password -s <service>` listed it with `svce` = the `service` argument and `acct` = the `name` argument. So `Bun.secrets` is not a private format — it is interoperable with the standard macOS tooling at the *metadata* level.

**A macOS caveat found empirically, and confirmed against an open Bun issue.** Reading the item back from a *fresh Bun process* returned the value with no prompt. Reading the same item with the `security` binary (`security find-generic-password -s <service> -w`) produced no output and had to be killed after 5 seconds — behaviour consistent with a blocking GUI authorization prompt, because macOS keychain ACLs are scoped to the creating application. I did not visually confirm the prompt, so treat that mechanism as inferred; the observable fact is that a *different* binary did not get the secret non-interactively.

Bun issue [oven-sh/bun#28071](https://github.com/oven-sh/bun/issues/28071) (open, labelled `docs`) reports the same mechanism from the other side and is directly design-relevant: because every Bun *script* runs through the same `bun` binary, macOS Keychain treats them all as one application, so **any Bun script running as the same user can silently read a secret stored by any other Bun script**, with no prompt. The issue notes that compiled binaries (`bun build --compile`) behave differently and do prompt, precisely because they are a distinct application identity.

Two consequences, and they pull against each other — this belongs in the distribution decision (research ticket 07), not just this one:

- If `pd` ships as a **Bun script** (`bunx`, npm install), the keychain gives real protection against *other users* and against a filesystem read, but **no protection against another Bun script on the same machine** — which, on a developer box running AI coding agents, is not a hypothetical population. The security gain over a `0600` file is then narrower than "OS keychain" makes it sound.
- If `pd` ships as a **compiled single-file executable**, it gets its own ACL identity and the isolation is real — but each new binary identity may re-prompt after an upgrade or a move, and a GUI prompt is unanswerable by a non-interactive agent. That is a "worked yesterday, hangs today" hazard.

Neither is disqualifying. Both must be stated in the spec rather than discovered later.

### 1.2 `@napi-rs/keyring` — works under Bun, but is redundant

Verified empirically: `bun add @napi-rs/keyring` installed `@napi-rs/keyring@1.3.0`, and a full `new Entry(service, name)` / `setPassword` / `getPassword` / `deleteCredential` round trip succeeded under Bun on macOS. Its README states it is a Node-API binding to the Rust crate [`keyring-rs`](https://github.com/hwchen/keyring-rs). It carries the same platform backends and therefore the same headless failure modes as `Bun.secrets`, plus a native-binary install step. Given `Bun.secrets` exists, this is a fallback of last resort, not a recommendation.

### 1.3 `keytar` — disqualified

`atom/node-keytar` is archived: "This repository was archived by the owner on Dec 15, 2022. It is now read-only." ([github.com/atom/node-keytar](https://github.com/atom/node-keytar)). It should not be adopted.

### 1.4 Shelling out to platform binaries

`security` is present at `/usr/bin/security` on macOS (verified). On Linux the equivalent is `secret-tool` from libsecret; it is **not** present on this machine, and it is not present in a minimal container image either. Shelling out buys nothing over `Bun.secrets` — same daemon dependency, worse error handling, an extra process spawn per invocation, and on macOS the ACL prompt problem above becomes *worse* rather than better because a shelled-out binary is a different application identity from the one that wrote the item.

**Conclusion: use `Bun.secrets`. Do not add a credential-storage dependency.**

---

## 2. What breaks headless

This matters more than usual here, because `map.md` states the primary consumer is an AI coding agent "on no particular harness" — which in practice means containers and CI.

- **Linux without a Secret Service daemon — tested, and the news is good.** `Bun.secrets` on Linux is libsecret over D-Bus. libsecret is a *client*; the secret must be served by a running Secret Service provider (gnome-keyring-daemon, KWallet, KeePassXC). A minimal container has neither the library nor a session bus. I ran both variants in `oven/bun:1` (Bun 1.3.14) on this machine:

  | Container state | Result | Elapsed |
  | --- | --- | --- |
  | stock image (no libsecret) | throws `Error`, `code: "ERR_SECRETS_PLATFORM_ERROR"`, message `libsecret not available` | **3 ms** |
  | `libsecret-1-0` installed, no D-Bus daemon | throws `Error`, `code: "ERR_SECRETS_PLATFORM_ERROR"`, message `Cannot spawn a message bus without a machine-id: Unable to load /var/lib/dbus/machine-id or /etc/machine-id … (code: 4)` | **6 ms** |

  `typeof Bun.secrets` is still `"object"` in both cases, so feature-detection on the property is useless — you must actually call and catch. Both failure modes **fail fast and do not hang**, and both are distinguishable by the stable `code` `ERR_SECRETS_PLATFORM_ERROR`. That single code is enough to classify "keychain not available here" and fall straight through the precedence chain. It also means the timeout suggested below is belt-and-braces rather than necessary for the container case (an SSH session against a *live but locked* keyring is a different scenario and remains untested).
- **Linux over SSH.** Even on a desktop distro, an SSH session has no D-Bus session bus unless one is started for it, and the login keyring is typically locked because it is unlocked by PAM at graphical login. So SSH is a second, distinct failure mode from "no daemon installed".
- **CI runners.** GitHub-hosted and comparable runners have no keyring daemon. This is precisely why `gh` documents a plaintext fallback and why every CLI surveyed below supports a token environment variable.
- **macOS headless / over SSH.** The login keychain is locked until unlocked; an SSH session does not unlock it. Additionally the ACL prompt is a GUI prompt with nobody to answer it, so the read blocks or fails rather than degrading gracefully. See Open Questions — I could not test this from an interactive session without risking a hang.
- **Windows.** Credential Manager is per-user and per-session; a service account or a Windows container has a different, more limited story. Not tested.

Design consequence: **the keychain can never be the only path, and a keychain failure must never hang.** Any keychain read should be treated as fallible and cheap-to-skip, not as the trunk of the resolution logic.

---

## 3. Config file location and permissions

### 3.1 The spec

freedesktop.org Base Directory Specification ([specifications.freedesktop.org/basedir/latest](http://specifications.freedesktop.org/basedir/latest/)):

- `$XDG_CONFIG_HOME` — "defines the base directory relative to which user-specific configuration files should be stored. If `$XDG_CONFIG_HOME` is either not set or empty, a default equal to `$HOME/.config` should be used."
- `$XDG_CACHE_HOME` — default `$HOME/.cache`. Relevant: `pd` has a cache, and the cache must live here, not next to the credential.
- `$XDG_STATE_HOME` — default `$HOME/.local/state`.
- On directory creation the spec says "an attempt should be made to create it with permission `0700`". It mandates `0700` and owner-only read/write only for `XDG_RUNTIME_DIR`; it does not mandate a mode for the config dir beyond the creation guidance.

### 3.2 The macOS tension, and how it is actually resolved

Apple's *File System Programming Guide* says app-specific data belongs in `~/Library/Application Support/<bundle-identifier>/`, and that you should "never create files in" `~/Library/Preferences` directly ([developer.apple.com](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)).

That guidance is aimed at bundled GUI applications. **Command-line tools do not follow it**, and the documented behaviour of the CLIs surveyed below proves it: `gh` documents its default config path as `$XDG_CONFIG_HOME/gh` falling back to `$HOME/.config/gh`, with a Windows-only `$AppData` branch and no macOS branch at all. Stripe documents `~/.config/stripe/config.toml` on all platforms. AWS uses `~/.aws/` on both macOS and Linux.

**Recommended for `pd`:** `$XDG_CONFIG_HOME/pd` → `$HOME/.config/pd` on macOS and Linux; `%AppData%\pd` on Windows (matching the `gh` precedent). Directory mode `0700`, credential file mode `0600`, both set explicitly at creation rather than relying on the process umask. Cache goes to `$XDG_CACHE_HOME/pd` → `$HOME/.cache/pd`, a separate tree.

---

## 4. What comparable CLIs actually do

### GitHub CLI (`gh`)

- Default storage: "After completion, an authentication token will be stored securely in the system credential store." ([cli.github.com/manual/gh_auth_login](https://cli.github.com/manual/gh_auth_login))
- Fallback: "If a credential store is not found or there is an issue using it gh will fallback to writing the token to a plain text file." Same page. The `--insecure-storage` flag is documented as "Save authentication credentials in plain text instead of credential store".
- Env override: `GH_TOKEN` / `GITHUB_TOKEN` — "Both token variables take precedence over previously stored credentials and eliminate authentication prompts." ([cli.github.com/manual/gh_help_environment](https://cli.github.com/manual/gh_help_environment))
- Config dir: `$GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `$AppData/GitHub CLI` on Windows, else `$HOME/.config/gh`. Same page.
- Accounts are modelled per **host** (`GH_HOST`, and stored credentials keyed by host), not as free-form named profiles.

This is the closest analogue to `pd` and the strongest single precedent: **keychain by default, documented plaintext fallback, env var wins over both.**

### Stripe CLI

- "All configurations are stored in `~/.config/stripe/config.toml`, including login credentials. You can use the `XDG_CONFIG_HOME` environment variable to override this location. The configuration file is not automatically removed when the CLI is uninstalled." ([docs.stripe.com/stripe-cli](https://docs.stripe.com/stripe-cli), `login` section)
- `stripe config --list` output in the docs shows `live_mode_api_key = "rk_live_abc123"` sitting in the file — **plaintext, no keyring** ([docs.stripe.com/cli/config](https://docs.stripe.com/cli/config)).
- Named profiles: the global `--project-name` flag selects a TOML section; the default section is `[default]`. Same page.
- Env vars: `STRIPE_API_KEY` and `STRIPE_DEVICE_NAME` "take precedence over all other values"; the `--api-key` flag "overrides your local configuration" for one-off commands ([docs.stripe.com/stripe-cli/keys](https://docs.stripe.com/stripe-cli/keys)).
- Stripe also mitigates by *scoping and rotating*: `stripe login` mints a restricted key rather than reusing the account's live secret key. That mitigation is not available to us — Pipedrive personal API tokens are full-account.

### AWS CLI

Documented precedence, highest first ([docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html)):

1. Command line options
2. Environment variables
3. Assume role / assume role with web identity
4. IAM Identity Center config
5. Credentials file (`~/.aws/credentials`)
6. Custom process (an external credential-sourcing program)
7. Config file (`~/.aws/config`)
8. Container credentials
9. EC2 instance profile credentials

Files are described as "plaintext files" in INI form ([cli-configure-files](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)). Profiles are `[default]` and `[profile name]` sections, selected by `AWS_PROFILE` or `--profile`. Notably AWS also documents "Sourcing credentials with an external process" — a hook that shells out to a user-chosen program that prints credentials on stdout. That is a clean escape hatch worth copying in spirit, and it is how a user with a corporate secret manager plugs in without us integrating anything.

AWS's own docs rank long-term plaintext credentials as "(Not recommended)" and external storage as "only as secure as the external location".

### Docker

Default is the weakest of the four and is the cautionary example: credentials are stored base64-encoded in `~/.docker/config.json`, which the docs call "less secure than configuring and using a credential store" ([docs.docker.com/reference/cli/docker/login](https://docs.docker.com/reference/cli/docker/login/)). Base64 is encoding, not encryption. The improvement path is `credsStore` (a single helper, e.g. `osxkeychain`, `wincred`, `pass`, with fallback to `secretservice` on Linux) or per-registry `credHelpers`. The helper protocol — an external binary named `docker-credential-<suffix>` speaking JSON on stdin/stdout — is the pluggability model AWS's "custom process" also uses.

### Synthesis

| CLI | Default at-rest | Fallback | Env override wins | Profile model |
| --- | --- | --- | --- | --- |
| `gh` | OS credential store | plaintext file, documented | yes | per-host |
| Stripe | plaintext TOML | n/a | yes | `--project-name` TOML section |
| AWS | plaintext INI | n/a | yes | `[profile x]`, `AWS_PROFILE` / `--profile` |
| Docker | base64 JSON | helper binaries opt-in | n/a | per-registry |

Every one of the four lets an environment variable win, and three of four store plaintext by default. `gh` is alone in defaulting to the keychain — and it still needed a documented plaintext fallback to work at all in CI.

---

## 5. Environment-variable leakage — what is real and what is folklore

Being precise here, because the imprecise version of this argument leads to bad design.

- **Process listing does not expose the environment on Linux.** `proc(5)` documents that access to `/proc/pid/environ` "is governed by a ptrace access mode `PTRACE_MODE_READ_FSCREDS` check" ([man7.org — proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)). Another unprivileged user cannot read your process's environment. So "`ps` leaks your env var" is **false** as usually stated.
- **The command line *is* exposed.** The same manual set documents no ptrace check for `/proc/pid/cmdline`, and `ps` shows other users' command lines by default on both Linux and macOS. This is the sharpest concrete conclusion of this section: **`pd` must never accept a credential as a command-line argument value.** A `--token <value>` flag would be strictly worse than the env var it was meant to improve on. If a flag is wanted, it must be `--token-file <path>` or a `-` stdin convention. Note that Stripe's `--api-key` flag and AWS's "command line options" precedence step both have exactly this weakness.
- **Shell history.** A user who types `export PD_API_TOKEN=...` writes the token into `~/.zsh_history` in cleartext. This is a genuine and common leak, and the mitigation is documentation: tell users to put the export in a file that is not history-recorded, or to use the keychain and skip the export entirely.
- **Inherited subprocess environments.** Anything `pd` spawns inherits the variable, as does anything the *agent harness* spawns. In an agent context the harness itself may echo its child-process environment into a transcript or a log. This is the leakage surface that most concerns the stated consumer of this tool.
- **CI logs.** GitHub Actions masks values registered with `::add-mask::` — "Masking a value prevents a string or variable from being printed in the log. Each masked word separated by whitespace is replaced with the `*` character" — and warns you must "register the secret with `add-mask` before outputting it in the build logs" ([docs.github.com — workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log)). Masking is a literal substring match on the raw value; a base64, URL-encoded or partially-printed form of the same secret is not masked. So CI masking is a safety net with holes, not a guarantee.
- **Read-only filesystem / immutable container images.** Cuts the other way — an env var is the *only* mechanism that works with no writable home directory at all.

**Verdict: the env var must be supported, and it must be first-class, not grudging.** Its dominant leak vectors (shell history, inherited environments) are user-controlled and documentable; its supposed dominant vector (process listing) does not exist. Every comparable CLI reaches the same conclusion.

---

## 6. Is encrypting the config file without a keychain worth anything?

**Mostly no. Say so plainly in the spec rather than shipping a reassuring word.**

If `pd` encrypts `~/.config/pd/credentials` with a key that also lives on the same disk — a key file, a value derived from the hostname or machine-id, or a constant baked into the binary — then any process running as that user can do exactly what `pd` does: read the key and decrypt. Against the threat that actually matters for a local CLI, an attacker or a rogue process with the user's own privileges, the encryption adds a function call and nothing else. Calling it "encrypted at rest" in the docs would be actively harmful, because it invites the user to relax a precaution they should keep.

Two honest qualifications:

1. **It does defend against accidental disclosure**, which is not nothing. A dotfiles repo committed to GitHub, a Time Machine or `tar` backup handed to someone, a `grep -r` across the home directory, a screen share, a support bundle. In every one of those the ciphertext survives the leak where the plaintext would not — *provided the key is not in the same tree that leaked.* That proviso does most of the work and is easy to get wrong.
2. **Passphrase-derived encryption is genuinely stronger** — but it re-imposes an interactive prompt on every invocation, which is the exact constraint the user has ruled out. An agent cannot answer a passphrase prompt. So it is not available to us.

The mechanism that *does* deliver real at-rest protection is the OS keychain, precisely because the key material is held outside the user's filesystem by a process with a different trust boundary, and because macOS additionally binds access to the requesting application. That is a real property, and `Bun.secrets` gives it to us for free.

**Recommendation: do not implement homegrown encryption.** Use the keychain where it exists; where it does not, write plaintext with mode `0600` and *tell the user in plain language that it is plaintext* — the `gh --insecure-storage` model. An honest plaintext file is safer in practice than a file the user has been told is encrypted.

---

## 7. Recommended precedence chain

Resolution order, first match wins, evaluated cheaply and without ever blocking on a prompt:

1. **`--token-file <path>`** (explicit, per-invocation). Read the token from a file. *No `--token <value>` flag* — see §5, argv is world-readable.
2. **`PD_API_TOKEN` environment variable.** The container, CI and agent-harness path. Bun's own docs endorse env vars for exactly this case.
3. **OS keychain via `Bun.secrets`**, keyed by `service = "pd"` and `name = <profile>` (default `"default"`). The interactive-human path, and the reason the credential is entered once.
4. **Plaintext file** `$XDG_CONFIG_HOME/pd/credentials` (mode `0600`), written only when the keychain was unavailable or when the user passed an explicit opt-in flag. Its presence should be reported by a `pd auth status` command so it cannot be forgotten about.
5. **Fail** with exit code 2 and a stderr message naming all four mechanisms and the profile that was searched.

Reasoning for putting the env var **above** the keychain rather than below:

- It matches every CLI surveyed. `gh`: token env vars "take precedence over previously stored credentials". Stripe: `STRIPE_API_KEY` "take[s] precedence over all other values". AWS: environment variables sit at step 2, above all file- and store-based sources.
- The override direction is the one users need. Someone with a stored personal credential who wants to run one command against a different account sets the variable for that command. The reverse — a stored credential silently winning over an explicitly exported one — is astonishing and produces requests against the wrong account.
- It keeps the container case on the fast path with no keychain probe, no D-Bus timeout, and no risk of a blocking prompt in an environment with nobody to answer it.

**Failure semantics.** Any exception from step 3 (`Bun.secrets` throws, per its docs) must be caught, logged to stderr at debug level as "keychain unavailable: <reason>", and treated as *absent*, falling through to step 4. A keychain fault must never be fatal and must never hang. Verified: on headless Linux the throw carries `code === "ERR_SECRETS_PLATFORM_ERROR"` and arrives in single-digit milliseconds (§2), so the common container case needs no special handling beyond the catch. A short timeout around the read is still worth having for the untested locked-keychain-over-SSH case.

**Named profiles.** Follow AWS and Stripe: a `--profile <name>` flag plus a `PD_PROFILE` environment variable, defaulting to `default`. The profile name is the `name` argument to `Bun.secrets` and the section key in the config file, so one selector drives both storage backends. Because `pd` is single-tenant per Pipedrive company account, the profile also naturally carries the account's API domain — which matters for custom-field hash resolution, since those hashes are per-account and the cache must be keyed by profile or it will serve one account's field names for another's.

**Store-time validation.** Yes, and it is cheap. `GET /api/v1/users/me` returns the authorized user with the bound company id, name and domain, at a documented cost of **2 API points** ([developers.pipedrive.com — Users](https://developers.pipedrive.com/docs/api/v1/Users)). Two points against a shared daily budget is a trivial price for turning a mistyped paste into an immediate error instead of a confusing failure on some later command. It also yields the company id/domain to store alongside the profile, and gives `pd auth status` something truthful to print. Validate on `pd auth login`; do **not** validate on every invocation.

---

## 8. Redaction discipline

The surfaces where a credential escapes a CLI by accident, and the rule that closes each:

| Surface | How it leaks | Discipline |
| --- | --- | --- |
| stderr diagnostics | An error object carrying the request `headers` is logged verbatim; a retry log prints the full request | The credential lives in exactly one place — the single client module (`map.md` locked decision 7). Nothing outside it ever holds the token string. Error values in the `neverthrow` union carry method, path, status and request id — never headers. |
| `--verbose` / debug HTTP dump | Prints the `Authorization` / `x-api-token` header | A single `redactHeaders()` applied at the one place headers are serialised, replacing known-sensitive header names with `***`. Allowlist the headers you print rather than denylist the ones you hide. |
| Cache **keys** | The token is folded into the key to scope the cache per account, and the key becomes a filename on disk | Never key on the token. Key on a **profile name** plus the company id returned by `/users/me`. If a token-derived component is genuinely needed, use a SHA-256 hex digest — the digest is not reversible and is safe as a filename. |
| Cache **contents** | The response body is stored, but so is the request that produced it | Persist the response body only. Never serialise the request headers into the cache entry. |
| `--pretty` output | A generic object dump walks a config or client structure and prints everything | `--pretty` renders domain records only, from typed values. Never `JSON.stringify` a config or client object. Keep the token behind an accessor so it is not an enumerable own property of anything that reaches a serialiser. |
| Uncaught exception traces | Runtime stack frames can include argument values | With `neverthrow` there are no thrown application errors; the boundary wrappers must not re-throw the original object. Install a top-level handler that prints a bounded message, not a raw dump. |
| The `--help` / manifest output | An example is generated from live config | Examples are static strings. |
| Shell completion and error echo | The tool echoes the offending argument back on a usage error | Since there is no `--token <value>` flag, no argument value is ever sensitive. This is a second reason for that decision. |

Precedent for the automatic form: GitHub Actions masks registered secrets in logs with `*` substitution, but only by literal substring match — a transformed or partially-printed secret slips through ([docs.github.com](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log)). A last-resort scrubber that replaces the known token string on every stderr write is therefore worth adding as a backstop, but must not be relied on as the primary control — it cannot catch a truncated, encoded or split rendering.

One more, specific to this tool: `pd` writes a cache under `$XDG_CACHE_HOME/pd`. Create that directory `0700` too. A cache of CRM records is not a credential, but it is still company data and it should not be world-readable.

---

## 9. Recommendation, in short

1. Use **`Bun.secrets`** (Bun ≥ 1.2.21). No npm dependency, all three platforms, verified working under Bun 1.3.14 on macOS. Wrap every call in `ResultAsync.fromPromise`; treat any throw as "absent", never as fatal — verified to fail in ~3–6 ms with `ERR_SECRETS_PLATFORM_ERROR` in a headless container, so the fallthrough is cheap.
2. Precedence: `--token-file` → `PD_API_TOKEN` → keychain → `0600` plaintext file → fail with exit 2. Env above keychain, matching `gh`, Stripe and AWS.
3. Config at `$XDG_CONFIG_HOME/pd` (`$HOME/.config/pd`), `%AppData%\pd` on Windows. Directory `0700`, credential file `0600`, both set explicitly.
4. **Never** a `--token <value>` flag — argv is readable by other users; the environment is not.
5. Profiles via `--profile` / `PD_PROFILE`, defaulting to `default`; the profile name is the keychain `name` and the config section key, and it must also scope the custom-field cache.
6. Validate once at store time with `GET /api/v1/users/me` (2 API points). Never per invocation.
7. **No homegrown encryption of the config file.** It is theatre against a local attacker. Write plaintext, set `0600`, and say "plaintext" in the message — the `gh --insecure-storage` model.
8. Redaction is structural, not cosmetic: the token exists in one module, error values never carry headers, cache keys never derive from the token.
9. Do not oversell the keychain either. If `pd` ships as a Bun script rather than a compiled binary, macOS grants no isolation between it and any other Bun script on the machine (Bun issue #28071). The keychain is still the best available default; the spec should just describe what it does and does not buy.

---

## 10. Open questions / not documented

*Two questions originally listed here — what `Bun.secrets` throws on headless Linux, and whether it hangs — were tested and answered; the results are in §2.*

1. **macOS behaviour over SSH with a locked login keychain.** Whether `Bun.secrets.get` fails fast, blocks, or returns `null`. I avoided testing this because a blocking GUI prompt in a non-interactive session is exactly the hazard being investigated. Unlike the container case, this is a *live* keychain that is merely locked, so the fast-fail result from §2 does not transfer.
2. **macOS ACL stability across binary upgrades.** The `security`-binary block observed here, and Bun issue #28071, both point to a per-application keychain ACL. Whether replacing a compiled `pd` binary in place, or moving it, triggers a re-prompt on the next read is unverified and is the single most likely cause of a "worked yesterday" failure for the interactive user.
3. **Windows.** Nothing was tested. `Bun.secrets` on Windows Credential Manager is documented but unverified here, as is the `%AppData%\pd` path choice and file-permission behaviour on NTFS (`0600` has no direct NTFS equivalent — the ACL must be set differently, and Node/Bun `chmod` on Windows is largely a no-op).
4. **Whether `ERR_SECRETS_PLATFORM_ERROR` is a stable contract.** It is observed, not documented — the `Bun.secrets` docs page lists no error codes. Matching on it is reasonable, but the fallthrough must not *depend* on it: catch any throw.
5. **Pipedrive token scoping.** Whether Pipedrive offers a restricted or read-only API token — the Stripe model of minting a scoped key at login. If it does, that would be a far stronger control than any storage decision, because it would make the stored credential incapable of writing and thereby enforce the read-only safety property at the credential level rather than in `pd`'s code. Not investigated here; worth a dedicated look in the auth decision ticket.
6. **OAuth as an alternative.** Pipedrive supports OAuth apps; whether a refresh-token flow is viable for a locally-installed CLI, and whether it would change the storage calculus (short-lived access token in memory, refresh token in the keychain), was out of scope for this ticket. Belongs to research ticket 05.

---

## Sources

- Bun — `Bun.secrets`: https://bun.com/docs/api/secrets
- Bun — v1.2.21 release notes (introduces `Bun.secrets`): https://bun.com/blog/release-notes/bun-v1.2.21
- Bun — issue #28071, keychain isolation between Bun scripts on macOS: https://github.com/oven-sh/bun/issues/28071
- `@napi-rs/keyring` README (from installed package 1.3.0); upstream Rust crate: https://github.com/hwchen/keyring-rs
- `atom/node-keytar` archive notice: https://github.com/atom/node-keytar
- GitHub CLI — `gh auth login`: https://cli.github.com/manual/gh_auth_login
- GitHub CLI — environment: https://cli.github.com/manual/gh_help_environment
- Stripe CLI — reference / `login`: https://docs.stripe.com/stripe-cli
- Stripe CLI — `config`: https://docs.stripe.com/cli/config
- Stripe CLI — API keys: https://docs.stripe.com/stripe-cli/keys
- AWS CLI — authentication and precedence: https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html
- AWS CLI — configuration and credential files: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
- Docker — `docker login` / credential stores: https://docs.docker.com/reference/cli/docker/login/
- freedesktop.org — XDG Base Directory Specification: https://specifications.freedesktop.org/basedir-spec/latest/ (fetched via its redirect to `http://specifications.freedesktop.org/basedir/latest/`)
- Apple — File System Programming Guide, macOS library directories: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
- man7.org — `proc_pid_environ(5)`: https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
- man7.org — `proc_pid_cmdline(5)`: https://man7.org/linux/man-pages/man5/proc_pid_cmdline.5.html
- GitHub Actions — workflow commands, masking: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log
- Pipedrive — Users API (`GET /users/me`, 2 API points): https://developers.pipedrive.com/docs/api/v1/Users
