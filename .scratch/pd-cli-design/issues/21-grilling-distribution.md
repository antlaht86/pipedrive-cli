# Distribution

> **Superseded 2026-08-13.** This ticket's decision became
> [ADR-0014](../../../docs/adr/0014-distribution.md), which
> [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) supersedes whole: `pd` is built
> from a clone with `bun build --compile` and there is no npm package. Kept as decision history.

Type: grilling
Status: resolved

Blocked by: 07

## Question

How does `pd` reach a machine, given users may not have Bun installed?

- Compiled binary, npm package, or shebang script, on ticket 07's findings. Weigh install friction, update path, startup time and binary size.
- Whose machine is the target: a developer's laptop, a CI runner, an agent harness's container. Each has a different tolerance for a missing runtime.
- How an agent harness discovers the executable, and whether install location is something the documentation must pin down.
- Cross-platform coverage, and whether an unsigned macOS binary is a practical problem.
- The update story, and whether a stale `pd` against a changed Pipedrive API fails legibly.
- Where the generated client sits in this — committed and built in, so a user never runs the generator.
- Whether `AGENTS.md` ships with the tool or lives only in the repo, given it is the canonical documentation a harness reads.

Record as an ADR.

## Context added while resolving other tickets

- **The plain npm package is still on the table, and [ADR-0012](../../../docs/adr/0012-authentication-and-credential-resolution.md) §4 is why.** Research 07 found that option survives only if `pd` avoids `Bun.*` APIs. ADR-0012 refused `Bun.secrets` — the one such API any decision had reached for — so as of ADR-0012 no locked decision requires the Bun runtime. Verify that before relying on it; a later ticket could spend the freedom.
- **Nothing needs to ship a credential.** ADR-0012 §3 puts the credential in `$XDG_CONFIG_HOME/pd/credentials`, `$PD_API_TOKEN` or a file path, none of which the installer touches. Install is code only.
- **The config path is a second per-user location beside the cache.** [ADR-0005](../../../docs/adr/0005-cache-design.md) §6 fixed `$XDG_CACHE_HOME/pd/`; ADR-0012 §3 fixes `$XDG_CONFIG_HOME/pd/`. Both need a Windows answer, and research 08 §10 point 3 flags that `0600` has no NTFS equivalent and `chmod` is largely a no-op there — so a Windows target makes the credential file's permission promise unenforceable, which is a distribution consequence rather than an auth one.

## Answer

Full detail in [ADR-0014](../../../docs/adr/0014-distribution.md).

**One channel: `@zimple/pd`, a public npm package, bin `pd`.** No compiled binary, no curl installer,
no Homebrew, no signing, no platform matrix, no glibc/musl split — the whole second half of research
07 is declined. The scoped name is forced: `pd`, `pipedrive-cli` and `pd-cli` are all taken on the
live registry, and `pd-cli` already installs a bin named `pd`. That PATH collision is accepted, not
solved; the command name `pd` is assumed by thirteen ADRs.

**The tarball is one bundled `.js`** — deps inlined, empty `dependencies`, `#!/usr/bin/env node`,
`engines.node >= 20`. Raw TypeScript was refused because Node only strips types natively from 24, so
shipping it would exclude Node 20 and 22 LTS for no gain.

**Bun is the build runtime, Node is the shipped runtime, and the split is now enforced.** ADR-0012 §4
preserved the `Bun.*`-free freedom and warned a later ticket could spend it; this is that ticket, and
it spends it by committing to it — an ESLint ban on the `Bun` global and `bun:*` imports plus a CI
gate, reusing ADR-0013 §1's machinery.

**No self-update check, ever.** The argument is architectural rather than ergonomic: a registry poll
is a non-Pipedrive HTTP request that either corrupts ADR-0011's rate-gate premise or performs exactly
the client bypass ADR-0013 spent four layers preventing. Staleness surfaces through ADR-0006's
existing `warning` lines.

**Semver on the agent contract**, `manifest_version` in lockstep with MAJOR, `pd_version` added to
the manifest, 1.0.0 at spec completion. Named cost: a new Pipedrive field is a MINOR that adds a key
to `record` lines, so a strictly-parsing agent can break on a MINOR.

**Windows supported** — `%LOCALAPPDATA%\pd\` and `%APPDATA%\pd\` — with the NTFS permission gap said
rather than papered over, via a platform-conditional entry in ADR-0013's `pd auth status` warnings.
ADR-0012 §5's removal of `pd auth login` is what shrinks the gap: `pd` reads the credential file and
never writes it.

**`AGENTS.md` ships in the tarball and `pd docs` emits it verbatim** — the third stdout exception
after `--help` and `manifest`, earning it by version-matching the docs to the binary and making setup
`pd docs >> AGENTS.md`.

**Global install is the only documented path**; no absolute path is pinned because the npm prefix
varies, and `npx @zimple/pd` is named as working but unsupported for agents because it unpins the
version.

**A thirteenth ADR-0001 variant, `unsupported_runtime`, exit 2**, because npm's `engines` field is
advisory and warns only — so the Node ≥ 20 floor needs `pd`'s own `process.versions.node` check to be
legible.
