# ADR-0014: How `pd` reaches a machine

Status: superseded
Date: 2026-08-12
Superseded by: [ADR-0021](0021-distribution-build-from-source.md) — `pd` is built from source with
`bun build --compile`; the npm channel, the Node target, `unsupported_runtime` and the `Bun.*` ban are
all withdrawn. Nothing below is normative. ADR-0021 restates the parts that survive — the semver
contract, the Windows path mapping, the no-self-update refusal and `pd docs` — so this document need
not be read to know what holds.
Deciding ticket: [Distribution](../../.scratch/pd-cli-design/issues/21-grilling-distribution.md)
Extends: [ADR-0001](0001-error-model-and-exit-codes.md) — adds a thirteenth variant, `unsupported_runtime`
Extends: [ADR-0005](0005-cache-design.md) §6 and [ADR-0012](0012-authentication-and-credential-resolution.md) §3 — both per-user paths gain a Windows mapping
Extends: [ADR-0009](0009-command-surface-and-manifest.md) — adds `pd docs` and `pd_version`
Extends: [ADR-0013](0013-read-only-enforcement.md) — `pd auth status` warnings gains a platform caveat
Spends: [ADR-0012](0012-authentication-and-credential-resolution.md) §4 — the `Bun.*`-free freedom it preserved is now committed and enforced

## Context

Research 07 measured the option table and found the two ends far cheaper than the middle. A plain
JS/TS npm package is a few hundred kilobytes and needs Node ≥ 20 or Bun on the host. A compiled
`bun build --compile` binary needs nothing from the host, starts in 21.5 ms, and ships 17–28 MB
compressed per platform behind a five-target CI matrix. The middle — a browser-downloaded binary —
requires Developer ID signing and notarization or macOS SIGKILLs it silently, exit 137.

Three facts narrowed the choice before this ADR opened.

**The npm option is genuinely available, not theoretically available.** It survives only if `pd`
avoids `Bun.*` and `bun:*` APIs. [ADR-0012](0012-authentication-and-credential-resolution.md) §4
refused `Bun.secrets` — the one such API any decision had reached for — and cutting `pd auth login`
removed the keychain tier that would have required it. [ADR-0005](0005-cache-design.md) §6 stores
the cache as plain `0600` files written through a temporary file and `rename`, not `bun:sqlite`. So
no locked decision requires the Bun runtime.

**Nothing about installation touches a credential.** ADR-0012 §3 resolves the token from
`--token-file`, `$PD_API_TOKEN`, or a `0600` file `pd` reads but never writes. The installer moves
code and nothing else.

**The consumer is an agent harness, and agent harnesses carry Node.** The compiled binary's real
prize is independence from an installed runtime. That prize is worth a permanent five-target release
pipeline only if a runtime-less consumer actually exists, and none does today.

## Decision

### 1. One channel: a public npm package

`pd` ships as `@zimple/pd` on the public npm registry, `bin: { "pd": "..." }`. `npm install -g @zimple/pd`.

No compiled binary. No curl installer. No Homebrew tap. No code signing, no notarization, no
`os`/`cpu`/`libc` platform packages, no glibc/musl split, no `-baseline` CPU variant, no
`optionalDependencies` fan-out. The entire second half of research 07 is declined.

The package name is scoped because the obvious unscoped names are taken, checked against the live
registry rather than assumed:

| name | state |
| --- | --- |
| `pd` | taken — "an ES5 / OO utility", `0.8.1` |
| `pipedrive-cli` | taken — "Command-line interface for Pipedrive CRM", `1.0.1` |
| `pd-cli` | taken — a Things3/Bear tool for macOS, and it installs a bin named **`pd`** |
| `@pipedrive/cli` | free, but the scope belongs to the vendor |

The **command** name stays `pd`, as every ADR in this map assumes. `pd-cli`'s bin is a real if narrow
PATH collision; it is accepted rather than solved, because renaming the command would rewrite
thirteen ADRs to dodge a Mac note-taking utility.

Public rather than private is a deliberate friction decision. A private registry would put an
`.npmrc` credential in front of every install site — laptop, CI runner, agent container — which is
exactly the place this map cares about. Nothing secret ships: ADR-0012 keeps every credential out of
the package, and ADR-0013 keeps every write out of the code.

### 2. The tarball is one bundled `.js`

A single pre-built file, `#!/usr/bin/env node`, with `zod`, `neverthrow`, `p-limit` and the generated
`@hey-api` client inlined. `dependencies` is empty. `engines.node >= 20`.

Bundling rather than declaring dependencies is chosen for three reasons specific to `pd`: the
dependency graph is four packages, so the saving from declaring them is a rounding error; an install
into a locked-down CI resolves nothing and is unaffected by `npm install --ignore-scripts`; and the
generated client is committed in this repo, so it never needs to exist in a user's `node_modules`.

Raw TypeScript is refused. Research 07 §2.1 measured Node v24.19.0 running `.ts` unmodified, but that
is a Node 24 fact, not a Node fact — shipping it would exclude the Node 20 and 22 LTS hosts for no
gain.

### 3. Bun is the build runtime; Node is the shipped runtime, and that is now enforced

Locked note 1 says Bun + TypeScript. This ADR does not change it — it separates two runtimes the note
conflated. Bun is the development, build and test runtime. The published artifact targets **Node ≥ 20
or Bun**.

That only holds while no `Bun.*` or `bun:*` reference reaches shipped code, so it stops being a
preference and becomes a checked constraint, using exactly the machinery
[ADR-0013](0013-read-only-enforcement.md) §1 built for the write-import ban:

- an ESLint rule banning the `Bun` global and every `bun:*` import in `src/**`
- a CI gate that fails the build on a violation

ADR-0012 §4 preserved this freedom and explicitly warned that a later ticket could spend it. This is
that ticket, and the freedom is spent by being committed to rather than by being consumed.

### 4. `pd` never checks for a newer version of itself

No registry poll, no cached daily check, no `pd version --check`.

The argument is not ergonomic, it is architectural. A registry check is an HTTP request that is not a
Pipedrive GET. Routed through the single client, it violates the premise [ADR-0011](0011-concurrency-and-retry.md)
rests on — that everything in the gate is a Pipedrive call subject to the same rate accounting.
Routed around the client, it is precisely the bypass ADR-0013 spent four layers preventing. Neither
is worth a convenience.

Updating is `npm install -g @zimple/pd@latest`, owned by whoever owns the harness.

A stale `pd` against a changed Pipedrive API already fails legibly, and it does so without this ADR
adding anything: [ADR-0006](0006-validation-placement-and-rejection.md) strips unknown keys and emits
one deduplicated `warning` line per cause, so a `pd` that has not caught up emits fewer fields and
says so, rather than corrupting output.

### 5. Two version surfaces, and what they promise

`pd --version` prints the package version. The manifest of [ADR-0009](0009-command-surface-and-manifest.md)
gains a `pd_version` string beside its existing `manifest_version` integer, so an agent can read both
"what am I talking to" and "did the contract break" from one object.

Versioning is strict semver, with MAJOR defined against the **agent-visible contract**:

| bump | means |
| --- | --- |
| MAJOR | an NDJSON line shape, a `type` tag, a trailer field, an exit code, an ADR-0001 error `code` string, or a command changes or disappears |
| MINOR | a new command, a new flag, or a new field on an existing line — additive only |
| PATCH | a fix with no contract change |

`manifest_version` increments in lockstep with MAJOR, so the two can never disagree. The first
release from this spec is `1.0.0`.

`pd --version` prints the bare semver string and nothing else — plain text on stdout, and therefore a
**fourth** stdout exception beside `--help`, `pd manifest` and `pd docs` (§7). It is not wrapped in
NDJSON, because a version flag whose output has to be parsed to be read is worse than the exception.
An agent that wants the version as data reads `pd_version` from the manifest, which is JSON already.

The cost is named rather than hidden: because ADR-0006 strips unknown keys, `pd` gaining coverage of
one more Pipedrive field adds a key to `record` lines, and that is a MINOR. An agent parsing strictly
can break on a MINOR. The alternative — every new field is a MAJOR — makes the number meaningless.

### 6. Windows is supported, with the weakened promise stated

Both per-user directories gain a Windows mapping:

| purpose | POSIX | Windows |
| --- | --- | --- |
| cache (ADR-0005 §6) | `$XDG_CACHE_HOME/pd/<token-hash>/`, default `~/.cache/pd/` | `%LOCALAPPDATA%\pd\<token-hash>\` |
| config (ADR-0012 §3) | `$XDG_CONFIG_HOME/pd/`, default `~/.config/pd/` | `%APPDATA%\pd\` |

Research 08 §10 flags that `0600` has no NTFS equivalent and `chmod` is largely a no-op there. That
matters less than it first appears, because ADR-0012 §5 removed `pd auth login`: `pd` **reads** the
credential file and never writes it, so the permission is the user's to keep and not a promise `pd`
breaks. What `pd` does write `0600` is the cache — company field schemas, not secrets.

The gap is said rather than papered over. On Windows, `pd auth status` adds an entry to the
`warnings` array [ADR-0013](0013-read-only-enforcement.md) §4 put there, stating that the credential
file's permission promise is unenforceable on this platform. No other command carries it, matching
ADR-0013's rule that a standing risk belongs on the one command whose job is to report standing risks.

Blocking the install with package.json's `os` field was refused: a pure-JS package runs on Windows
for free, and excluding a platform we are not paying for is an act of exclusion, not of economy.

"Supported" is not a claim made without evidence, so CI runs the test suite on a Windows runner
alongside the POSIX one. Path resolution is the whole reason: `%LOCALAPPDATA%` and `%APPDATA%`, the
absent XDG variables, and the separator are the only Windows-specific code in `pd`, and they are
exactly what an untested platform gets wrong.

### 7. `AGENTS.md` ships, and `pd docs` emits it

`AGENTS.md` is a published file in the tarball, and `pd docs` writes it verbatim to stdout.

This is the **third** exception to the NDJSON stdout rule, after `--help` and `pd manifest` — and §5's
`pd --version` makes a fourth. It is also the **fourth** grammar exception in ADR-0009's
`pd <resource> <verb> [id]`, beside `pd manifest`, `pd cache info|clear` and `pd auth status`. Every
exception is counted out loud because the rule's value is its rarity.

It earns them by guaranteeing the documentation matches the installed version rather than whatever
`main` says, and by turning harness setup into one command:

```
pd docs >> AGENTS.md
```

Locked note 4 makes `AGENTS.md` canonical and has harness-specific files point at it; `pd docs` is
how the pointing is done without a network fetch.

### 8. Global install is the documented path; `npx` is named and not blessed

`AGENTS.md` documents exactly one install: `npm install -g @zimple/pd`, after which `pd` is on `PATH`.

No absolute install path is pinned. The npm global prefix varies by platform, by Node version manager
and by container, so "on `PATH` after a global install" is the only promise that holds everywhere,
and it is the only one made.

`npx @zimple/pd` is named in `AGENTS.md` as working but unsupported for agent use, because it
silently resolves to whatever the registry served that minute — unpinning a version the agent may
have been instructed to expect — and adds a network dependency to a tool whose entire premise is
spending network budget carefully. `pd` does nothing at runtime to detect or refuse it: a
documentation problem does not earn a runtime check.

### 9. `engines` only warns, so the runtime check is `pd`'s own

Research 07 §2.2 quotes npm's documentation directly: `engines` "is advisory only and will only
produce warnings" unless `engine-strict` is set. `engines.node >= 20` therefore stops nothing.

`pd` reads `process.versions.node` before anything else runs. Below major 20 it emits one
ADR-0001-shaped error line and exits **2**, rather than letting a bundle die with a raw `SyntaxError`
an agent cannot classify. This is a thirteenth ADR-0001 variant, `unsupported_runtime`, exit 2,
`retry: never` — a usage error, because the fix is the caller's environment and not `pd`'s state.

That promise only holds if the bundle **parses** on the runtime it is refusing, so the check is not
merely first to execute: it must be written in syntax an older Node can read. The bundle targets
ES2020, and the version check sits in a prelude that uses nothing newer. A modern syntax target would
kill the process at parse time, before `pd`'s own diagnostic could run, and hand the agent back the
raw `SyntaxError` this section exists to prevent.

## Consequences

- **[ADR-0001](0001-error-model-and-exit-codes.md) grows to thirteen variants.** `unsupported_runtime`,
  exit 2, `retry: never`. Non-breaking by ADR-0001's own compatibility rules; the mapping table
  shipped in the manifest gains the entry automatically.
- **[ADR-0005](0005-cache-design.md) §6 and [ADR-0012](0012-authentication-and-credential-resolution.md) §3
  gain a Windows mapping each.** Neither POSIX path changes. ADR-0005 §6's reason for refusing a
  path beside the binary — "ticket 21 may ship `pd` as a compiled binary on a read-only path" —
  no longer applies, but its decision stands on the remaining reasons and is not revisited.
- **[ADR-0009](0009-command-surface-and-manifest.md) gains `pd docs` and `pd_version`.** `pd docs` is
  additive, so by §5 it is a MINOR. The manifest's `manifest_version` does not move.
- **[ADR-0013](0013-read-only-enforcement.md) §4's `warnings` array gains a platform-conditional
  entry.** `pd auth status` still makes zero requests and still writes nothing.
- **[ADR-0012](0012-authentication-and-credential-resolution.md) §4's open door is now closed
  deliberately.** No future ticket may reach for a `Bun.*` API without reopening this ADR, and §3's
  CI gate is what will tell it so.
- **[Ticket 28](../../.scratch/pd-cli-design/issues/28-grilling-testing-strategy.md) inherits a third
  named check** beside the two ADR-0013 gave it: the `Bun.*`/`bun:*` ban of §3. It may decide how it
  is structured; it may not decide whether it exists. It also inherits a question it does own —
  whether the test suite runs against Node as well as Bun, given the shipped artifact targets Node.
- **Startup cost is now the Node floor.** Research 07 §1.3 measured `node -e 'void 0'` at 35.8 ms on
  the reference machine, against 21.5 ms for the compiled binary. Roughly 14 ms is spent per
  invocation to avoid a five-target release pipeline, and it is invisible next to one Pipedrive
  round-trip.
- **Research 07's `.env` footgun dies with the binary.** §1.4 found a compiled executable auto-loads
  `.env` and `bunfig.toml` from the process CWD — a real hazard for a tool an agent `cd`s around
  with. `--no-compile-autoload-dotenv` is not needed, because nothing is compiled.
- **The build gains two responsibilities.** It must bundle to a single Node-targeting file, and it
  must stamp the version so `pd --version` and the manifest's `pd_version` agree with the published
  package. Research 07 §1.4's `--define` trick is the Bun-side mechanism.
- **`AGENTS.md` gains** an install section: the one supported install line, the `npx` caveat, the
  Node ≥ 20 requirement, and the two per-user directory locations per platform.
