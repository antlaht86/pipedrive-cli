# 18 — `--pretty`

**What to build:** A human runs `pd deals list --limit 20 --pretty` at a terminal and reads an aligned table instead of NDJSON. It is documented as unstable, an agent is told never to invoke it, and it cannot become a second contract by accident.

**Blocked by:** 17

**Status:** done

Normative: ADR-0002 §pretty (output format), ADR-0016 §key order, ADR-0005 §cache warnings.

Notes for the implementer:

- `--pretty` switches to an **aligned human table with no JSON in it**, buffered to compute column widths.
- **It is explicitly unstable** and has **no machine-readable error object at all** — only the stderr line.
- The manifest marks it `machine_readable: false` and carries the instruction never to invoke it from an agent (ticket 16).
- **Under `--pretty`, key order is selector order**, not `pd`'s schema order. In machine mode it is schema order. This is the one place the two differ, and it is safe precisely because `--pretty` is not a contract.
- A `cache_entry_skipped` warning goes to **stderr** under `--pretty`, where it goes to stdout in machine mode.
- Buffering here does not make the command a `collect` — `delivery` in the manifest describes the machine path.

- [x] `--pretty` renders an aligned table with no JSON on stdout
- [x] Column widths are computed by buffering, and wide values do not break alignment
- [x] Under `--pretty` an error produces only the stderr line and no machine-readable error object
- [x] Column order under `--pretty` follows `--fields` selector order
- [x] `cache_entry_skipped` goes to stderr under `--pretty`
- [x] The manifest marks `--pretty` `machine_readable: false` with the never-invoke instruction
- [x] `--pretty` is documented as unstable in `--help` and in `AGENTS.md`

## Comments

**2026-08-13 — handoff from ticket 03.** ADR-0012 §5 ends with "`--pretty` renders the same fields as
human text" for `pd auth status`. Ticket 03 built the command and its JSON object but **not** the
`--pretty` path: today `pd auth status --pretty` is a `usage` refusal, because the aligned renderer,
the flag's registration and the never-invoke contract all live here and a one-off human renderer
there would be a second implementation to delete. This ticket owes `pd auth status` a `--pretty`
rendering of `found`, `tier`, the path, `fingerprint`, `cache_dir_exists`,
`credential_is_write_capable` and the `warnings` array, and owes the argument parser in `src/cli.ts`
the flag itself. The same applies to the other single-JSON-object surfaces as they arrive.

**2026-08-13 — ratified as [ADR-0022](../../../docs/adr/0022-credential-resolution-edge-cases.md)
§3.** The deferral above is now recorded at ADR level rather than only as a handoff note, and
ADR-0012 §5 carries an inline pointer to it. `pd auth status --pretty` is a `usage` refusal until
this ticket lands; closing it means the flag renders `found`, `tier`, the path, `fingerprint`,
`cache_dir_exists`, `credential_is_write_capable` and the `warnings` array as human text.

**2026-08-19 — acceptance verified.** The boxes were never ticked when the ticket was closed. Each
was checked against the code and its test rather than from memory:

- The aligned non-JSON table, the buffered widths and the selector column order are one test,
  `test/pretty.test.ts` "buffers records into an aligned non-JSON table in selector order" — it
  asserts no `{` and no `"` on stdout, and that a title wider than its heading starts at the same
  column as that heading.
- The error paths are `NdjsonWriter.error`'s `if (!this.#pretty)` guard, covered twice: a usage
  error and a failed walk that prints its fetched rows and no machine object.
- `cache_entry_skipped` reaching stderr is `NdjsonWriter.warn`'s `#humanWarning` branch and its own
  test.
- `machine_readable: false` and the never-invoke instruction are one entry in
  `FLAG_DEFINITIONS` (`src/command-table.ts`), and `flagHelpLine` prints that same instruction
  string into `--help`, so the manifest and the help text cannot drift apart. `AGENTS.md:54` carries
  it a third time. `test/manifest-help.test.ts` asserts all of them.

The `pd auth status --pretty` debt recorded above and ratified as ADR-0022 §3 is also paid:
`src/cli.ts:108` renders it through `renderObjectTable`, and `test/pretty.test.ts` covers the status
object, `pd cache info` and the auth usage error.
