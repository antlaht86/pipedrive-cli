# 19 — `AGENTS.md`, `pd docs` and the `CONTEXT.md` pass

**What to build:** A harness author runs `pd docs` and gets `AGENTS.md` verbatim on stdout. Harness setup is one command, and the documentation always matches the installed version rather than a web page written against a different release.

**Blocked by:** 16

**Status:** ready-for-agent

Normative: [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) §5 (`pd docs`, embedding), plus the twelve ADRs listing required content. This is deliverable 1 and 3 of design ticket 22.

## What `AGENTS.md` must carry

Twelve ADRs each name content it must hold:

- the grammar `pd <resource> <verb> [arg] [flags]` and the three verbs
- the ten resources and the named exception group
- the never-`--pretty` sentence
- the `--limit` instruction, and the fact that the 10,000-record warning **may never arrive**
- the credential chain, all tiers, in precedence order
- the write-capable-token paragraph
- the install lines — `git clone`, `bun install`, `bun run build`, and that putting `dist/pd` on `PATH` is the reader's own step — plus the Bun version floor and the sentence that `pd` never updates itself
- the two per-user directory paths per platform (config and cache, POSIX and Windows)
- the do-not-parse-stderr paragraph
- the `pd fields list` recipe for learning a hash
- the two-command join recipe, **as the design rather than as an apology**
- the `--search-in` versus `--fields` distinction
- the `--limit`-on-search note
- the honest **no-budget-guard** paragraph
- the note that parallel `pd` invocations against one credential are **not free**

Notes for the implementer:

- `AGENTS.md` is **embedded into the binary at build time** and `pd docs` emits it **verbatim** — same bytes, no templating at runtime, never read from disk, never resolved against the executable's directory or the CWD. A compiled binary has no sibling files.
- `pd docs` is one of the named non-NDJSON stdout commands and rejects `--fields` as a usage error.
- **The risk carried into implementation, and it belongs in the documentation:** a user may hand `pd` an administrator's token, giving a fully privileged credential to a program whose safety rests on its own correctness. The mitigation is documentation — `pd auth status`, the root `--help` opening, and one `AGENTS.md` paragraph — plus a restricted Pipedrive permission set, which is account administration and outside `pd`'s reach. Name it plainly.
- Also produce the harness-specific pointer files alongside `AGENTS.md`.
- **`CONTEXT.md` pass.** The glossary stops at ADR-0011's terms. Terms settled later and not recorded: *hit*, *push-down*, *sentinel*, *seam*, *anomaly line*, *projection*, *absence*.
- When this ticket and ticket 20 are both done, design ticket 22 in `.scratch/pd-cli-design/issues/` can be resolved. Do not close it before then.

- [ ] `AGENTS.md` exists and carries every one of the fifteen content items listed above
- [ ] `pd docs` prints `AGENTS.md` byte-for-byte, asserted against the built binary rather than the source tree
- [ ] `dist/pd` copied to an unrelated directory still emits the full `AGENTS.md`
- [ ] `pd docs --fields x` is a usage error, exit 2
- [ ] The administrator-token risk paragraph is present in `AGENTS.md` and echoed in the root `--help` opening
- [ ] Harness-specific pointer files are written
- [ ] `CONTEXT.md` gains entries for hit, push-down, sentinel, seam, anomaly line, projection and absence
