# 16 — One command table: `pd manifest` and every `--help`

**What to build:** An agent runs `pd manifest`, calls `JSON.parse` on stdout once, and learns the entire command surface — every command, flag, selectable field, line type, warning kind, error code and exit code. It compares one integer, `manifest_version`, to know whether it can read the contract at all. A harness discovers the contract instead of hardcoding it.

The manifest and every `--help` text are generated from **one in-code command table**, so they cannot drift.

**Blocked by:** 07

**Status:** done

Normative: ADR-0009 §10 (command surface and manifest), ADR-0016 §8 (selectable fields), ADR-0001 (the code union).

Notes for the implementer:

- `pd manifest` is a **subcommand emitting one JSON object** — not a flag and not a committed file.
- It carries:
  - `manifest_version` (integer, moves only on a breaking change) and `pd_version` (release string)
  - `read_only: true` beside `read_only_scope: "pipedrive_api"`, so `pd cache clear` is visibly not a loophole
  - commands split into resource commands and the named exceptions, with per-command arguments, flags, the `--fields` selectable-field list, and `delivery: "streams" | "collects"`
  - the global flag table, with `--pretty` marked `machine_readable: false` and carrying the instruction **never to invoke it from an agent**
  - the vocabularies an agent must branch on: `type` line kinds, warning `kind` values, the `resolved` values, exit codes 0/1/2/3, and the full `code` union with its exit-code and `retry` mapping
  - the trailer fields `complete`, `emitted`, `skipped`, `duplicates`, `resolved`, `requests`
  - the output format, declared **once globally** as NDJSON
  - `--filter-id` marked `"enumerable": false`, because `pd` has no command that lists filter ids
- **It must not express a per-command request cost** — `pd users get 42` legitimately costs zero requests on a warm cache.
- **Custom-field hashes are not in the manifest**: they are per-account and `pd fields list` serves them.
- **The `resolved` vocabulary in the manifest is `"off"` / `"partial"` / `"full"`.** ADR-0009 §10's `none` is a mis-citation; ADR-0008 wins.
- **`unknown_command` is not a `code`.** The union is the thirteen variants of ADR-0001, and an unrecognised command is `usage`.
- **The nine global flags, by name:** `--pretty`, `--no-cache`, `--max-requests <n>`, `--limit <n>`, `--resolve`, `--resolve-budget <n>`, `--token-file <path>`, `--verbose`, `--fields <a,b>`. The table is flat with no per-command overrides; the manifest says where each applies.
- **The named exceptions, in full:** `pd manifest`, `pd cache info`, `pd cache clear`, `pd auth status`, `pd docs`. These are the complete set; the grammar governs resources and none of these is one.
- **Non-NDJSON stdout, by name:** `--help`, `pd manifest`, `pd auth status`, `pd cache info`, `pd docs`, `pd --version`.
- Root `--help` **opens with the read-only statement** and splits into `RESOURCES` and `OTHER`.
- **Counts drift; enumerate instead.** Several ADRs state ordinals that are now stale. State no total that is not also a list, in the manifest, in help text and in code.
- Semver MAJOR is defined against the agent-visible contract — a line shape, a `type` tag, a trailer field, an exit code, a `code` string, or a command changing or disappearing — and `manifest_version` moves **in lockstep**. A new field on an existing line is MINOR.

- [x] `pd manifest` emits exactly one JSON object that `JSON.parse` accepts whole
- [x] It carries `manifest_version`, `pd_version`, `read_only`, `read_only_scope`, the command split, the nine global flags, the four vocabularies, the six trailer fields, and the global NDJSON declaration
- [x] Per-command `--fields` selectable lists are present and match what the projection layer accepts
- [x] `--pretty` is marked `machine_readable: false` with the never-invoke instruction
- [x] `--filter-id` is marked `"enumerable": false`
- [x] `resolved` lists `off` / `partial` / `full`
- [x] The `code` union lists all thirteen variants with their exit codes and `retry` values, and does not contain `unknown_command`
- [x] No per-command request cost appears anywhere in the manifest
- [x] No custom-field hash appears in the manifest
- [x] Manifest and every `--help` text are generated from one in-code table, asserted by a test that changing the table changes both
- [x] Root `--help` opens with the read-only statement and splits into `RESOURCES` and `OTHER`
- [x] `pd --version` and the manifest's `pd_version` agree, asserted against the **built bundle**

## Comments

**2026-08-13 — from ticket 03.** `pd auth status` and its `--token-file` flag are wired by a
placeholder argv loop in `src/cli.ts`, deliberately the smallest thing that serves one command.
Replace it with the command table rather than growing it. Two things it already owes the manifest:
`pd auth status` as an emitter of a single JSON object rather than an NDJSON stream (ADR-0012 §5),
and the `usage` refusal of a `--token-file` that does not resolve
([ADR-0022](../../../docs/adr/0022-credential-resolution-edge-cases.md) §1). No new error `code` is
involved — `usage` and `auth` already exist and ADR-0001's union is unchanged. Zod on argv is
deferred to this ticket too, so the schema is written once against the real table.

**2026-08-17 — verification.** The work landed in `75e036a`, `9ed4176` and `33f65e0`. Checked box by
box against `test/manifest-help.test.ts`, `test/binary-smoke.test.ts` and the built `dist/pd`.

| Box | Evidence |
| --- | --- |
| One JSON object `JSON.parse` accepts whole | `test/binary-smoke.test.ts` runs `pd manifest` on the built binary and parses it with Zod; the run emits one line |
| Carries the named members | "enumerates commands, fields, flags and branching vocabularies" asserts each by name, not by count |
| Per-command `--fields` lists match the projection layer | "selectable fields are taken from the same runtime schemas" |
| `--pretty` marked `machine_readable: false` with the instruction | same test, plus the rendered help |
| `--filter-id` marked `enumerable: false` | same test |
| `resolved` is `off` / `partial` / `full` | same test |
| The `code` union with exit codes and `retry`, no `unknown_command` | same test, built from `ERROR_CODES` so a new variant cannot be published without appearing here |
| No per-command request cost | "carries no per-command request cost and no custom-field hash" |
| No custom-field hash | same |
| Manifest and help from one table | "changing one table entry changes both manifest and help" |
| Root help opens read-only, splits `RESOURCES` / `OTHER` | "root and command help are generated from the table" |
| `pd --version` agrees with `pd_version`, against the built bundle | `test/binary-smoke.test.ts`, and the `binaryGate` in `scripts/release-gates.ts` that CI runs on Linux and Windows |

Two boxes were true but unasserted, and now are: the manifest carries no per-command cost and no
custom-field hash. Both would be added in good faith by someone helpful — a cost looks like what an
agent wants to plan against, a hash looks like a selectable field — so the new test walks the whole
serialised object rather than checking the one key a reader would think of.

**Two counts in this list are stale, and the ticket says so itself.** Line 33: *"Counts drift;
enumerate instead. Several ADRs state ordinals that are now stale. State no total that is not also a
list."*

- "the four vocabularies" — there are **five**, and the ticket body enumerates all five one paragraph
  earlier: line kinds, warning kinds, `resolved`, exit codes, and the `code` union. The manifest
  carries exactly that enumeration.
- "all thirteen variants" — the union is **twelve**: ADR-0001's eleven plus `write_blocked` from
  ADR-0013. `src/lib/errors.ts` defines twelve, the manifest publishes twelve, and the test builds
  the list from the source of truth so the two cannot disagree.

Both boxes are ticked against the enumeration rather than the number. Neither count was changed in
this list, because the ticket is a record of what was asked.
