# 05 — `pd deals list`: the full walk

**What to build:** An agent runs `pd deals list` and receives every deal in the account as NDJSON on stdout — one `type`-tagged JSON value per line — across as many cursor pages as it takes, ending in exactly one trailer that states whether the answer is complete. It never learns what a cursor is. Records start arriving in about 250 ms rather than after twenty seconds of silence. A bad record costs one `warning` line, not its whole page.

This is the tracer bullet: argument parsing, the walk, two-stage validation, deduplication, the writer, the error union and the exit codes, all end to end.

**Blocked by:** 03, 04

**Status:** ready-for-agent

Normative: ADR-0001 (error model and exit codes), ADR-0002 (output format), ADR-0003 (pagination), ADR-0004 (streaming and composition), ADR-0006 (validation placement).

## The line grammar

One JSON value per line, each carrying `type` ∈ `record`, `warning`, `summary`, `error`. Records carry `record_type` in the **singular** — `"deal"` for `pd deals list`. A run ends with **exactly one** trailer, either a `summary` or an `error`, never both, and **the last line always carries `complete` and `emitted`**, whatever its type.

```json
{"type":"summary","complete":true,"emitted":40000,"skipped":3,"duplicates":0,"resolved":"off","requests":80}
{"type":"error","code":"invalid_response","message":"…","exit_code":1,"retry":"never","complete":false,"emitted":3200,"skipped":0,"duplicates":0,"resolved":"off","requests":9,"details":{}}
{"type":"warning","kind":"record_rejected","resource":"deal","id":4711,"path":"person_id","issue":"invalid_type","message":"Expected int, received null."}
```

**Spec ruling, not negotiable:** `resolved` is `"off"` / `"partial"` / `"full"`. ADR-0009 §10's `none` is a mis-citation; ADR-0008 wins.

Notes for the implementer:

- Argument parsing via `util.parseArgs`; **no CLI framework**.
- `zod` for all runtime validation, `neverthrow` for errors as values, `p-limit` for concurrent HTTP work. No substitutes.
- A paginated read is `AsyncGenerator<Result<Page, PdError>>`. A `Page` carries validated, deduplicated, bounded records, its own warnings, its duplicate count, and `bound` on the final page only. The generator owns validation, deduplication and the bound; **nothing downstream re-filters**. It keeps no running total — `bound` rides on the page so there is exactly one cumulative record count in the process.
- A page is **atomic**: either an `Ok` page or a terminal `Err`, never a partial page.
- One `NdjsonWriter` is the only thing that writes to stdout. It owns `emitted`, `skipped`, `duplicates` and warning deduplication, writes the single trailer, and **refuses a second call**. A run that exits with no trailer is a bug and surfaces as `internal`.
- **The walk never sees a retryable failure** — retry, backoff, the 429 inference and the Cloudflare stop all live beneath it in ticket 04.
- `collect` exists as the specified non-streaming path for any command needing whole-set post-processing. It reuses the same writer and on failure emits `emitted: 0`, writing none of the records it holds. **No command uses it yet**; any that does is marked `delivery: "collects"` in the manifest.
- **Two validation stages, failing differently.** Body not JSON, `data` absent or not an array, or `next_cursor` present with a wrong type → structural → `Err(invalid_response)`, walk ends. An element of `data` failing the record schema → per-record → `warning`, `skipped += 1`, walk continues.
- **Unknown keys are stripped.** A `record` line's shape is a function of `pd`'s version, not Pipedrive's release schedule. **One protected exception**: `custom_fields` is `z.record(z.string(), z.unknown())` and no patch may close it.
- **A first page whose non-empty `data` yields zero survivors is `invalid_response`, exit 1.** No later page ever escalates and there is no ratio threshold — old records cluster on early pages under keyset-like cursors, so a wholly rejected later page is the survivable case.
- `warning` lines are deduplicated by **cause** — `(resource, field path, zod issue code)` — while `skipped` counts every record. The writer stops emitting after **50 distinct causes** and keeps counting. `path` is record-relative (`person_id`, never `data.7.person_id`). `id` is best-effort and **omitted** when unrecoverable, never `null`.
- Deduplication holds every id seen for the whole run, no cap, no sliding window.
- Page size is internal and fixed at the endpoint maximum, 500 for list. **There is no resumption token**, no `--max-pages`, no `--all`, no `--no-validate`.
- **Value formatting:** money is a JSON number with `currency` as a flat sibling. Time passes through byte-for-byte and is never parsed. A field with no value is an **absent key** — only `null` and absent are absence; `[]`, `""` and `0` are values. `custom_fields` is exempt and stays byte-identical passthrough (`{}` when empty). `id` is never absent. `weighted_value` does not exist in v2 and `pd` neither emits nor computes it.
- **Errors are data on stdout**, in the same shape family as success — never stderr-only. `code`, `message`, `exit_code` and `retry` on every error. `details` is explicitly unstable and has URLs redacted before entry.
- **Regenerate the prototype samples** under `.scratch/pd-cli-design/prototypes/10-output-format/`. ADR-0002 declares them the normative examples and the only guard against format drift, and they currently predate `skipped` and `duplicates`. Every later ticket tests against them, so this is correctness work rather than tidying.

- [ ] `pd deals list` walks every page to a `null` cursor and emits one `record` line per deal
- [ ] The run ends in exactly one trailer, `summary` or `error`, carrying `complete`, `emitted`, `skipped`, `duplicates`, `resolved`, `requests`
- [ ] `resolved` is `"off"` on an unresolved run
- [ ] A last page with `next_cursor: null` completes the walk rather than failing the envelope (replay test)
- [ ] A structural failure ends the walk as `invalid_response`, exit 1
- [ ] One bad record produces one `warning` and `skipped += 1`, and the page's other records survive
- [ ] A first page whose non-empty `data` yields zero survivors is `invalid_response`, exit 1
- [ ] Warnings deduplicate by cause and stop at 50 distinct causes while `skipped` keeps counting
- [ ] Records repeated across pages are suppressed and counted in `duplicates`
- [ ] First records reach stdout in roughly 250 ms, not after the whole walk
- [ ] The writer refuses a second trailer, and a trailerless exit surfaces as `internal`
- [ ] Absent values are omitted keys; `[]`, `""` and `0` survive; `custom_fields` passes through byte-identical
- [ ] The prototype sample files are regenerated and match the writer's output byte for byte
