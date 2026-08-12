# Distribution

Type: grilling
Status: open

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
