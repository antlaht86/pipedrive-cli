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

- [ ] `--pretty` renders an aligned table with no JSON on stdout
- [ ] Column widths are computed by buffering, and wide values do not break alignment
- [ ] Under `--pretty` an error produces only the stderr line and no machine-readable error object
- [ ] Column order under `--pretty` follows `--fields` selector order
- [ ] `cache_entry_skipped` goes to stderr under `--pretty`
- [ ] The manifest marks `--pretty` `machine_readable: false` with the never-invoke instruction
- [ ] `--pretty` is documented as unstable in `--help` and in `AGENTS.md`

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
