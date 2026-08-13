# 05 — `pd deals list`: the full walk

**What to build:** An agent runs `pd deals list` and receives every deal in the account as NDJSON on stdout — one `type`-tagged JSON value per line — across as many cursor pages as it takes, ending in exactly one trailer that states whether the answer is complete. It never learns what a cursor is. Records start arriving in about 250 ms rather than after twenty seconds of silence. A bad record costs one `warning` line, not its whole page.

This is the tracer bullet: argument parsing, the walk, two-stage validation, deduplication, the writer, the error union and the exit codes, all end to end.

**Blocked by:** 03, 04

**Status:** done

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

- [~] `pd deals list` walks every page to a `null` cursor and emits one `record` line per deal — **true under replay, not yet against a live account.** `zGetDealsItem` types `won_time` and `lost_time` non-nullable and requires `expected_close_date`, which an open deal has none of, so a real first page is wholly rejected and the run is `invalid_response` under ADR-0006 §4. The walk is not what is wrong; the spec is. Closing this box is the `parser.patch` task of ADR-0006 §9, which needs observed responses. Filed as [ticket 21](21-the-nullability-patch-list.md); see also ADR-0024's consequences.
- [x] The run ends in exactly one trailer, `summary` or `error`, carrying `complete`, `emitted`, `skipped`, `duplicates`, `resolved`, `requests`
- [x] `resolved` is `"off"` on an unresolved run
- [x] A last page with `next_cursor: null` completes the walk rather than failing the envelope (replay test)
- [x] A structural failure ends the walk as `invalid_response`, exit 1
- [x] One bad record produces one `warning` and `skipped += 1`, and the page's other records survive
- [x] A first page whose non-empty `data` yields zero survivors is `invalid_response`, exit 1
- [x] Warnings deduplicate by cause and stop at 50 distinct causes while `skipped` keeps counting
- [x] Records repeated across pages are suppressed and counted in `duplicates`
- [x] First records reach stdout in roughly 250 ms, not after the whole walk
- [x] The writer refuses a second trailer, and a trailerless exit surfaces as `internal`
- [x] Absent values are omitted keys; `[]`, `""` and `0` survive; `custom_fields` passes through byte-identical
- [x] The prototype sample files are regenerated and match the writer's output byte for byte

## What the implementation settled, for the tickets that inherit it

Four of these were inventions rather than readings, so they are ratified in
[ADR-0024](../../../docs/adr/0024-the-unclassified-4xx-the-reported-cause-and-the-stderr-pair.md)
rather than left here: where a ticket and an ADR disagree, the ADR wins.

- **An unclassified 4xx is `internal`, exit 1** (ADR-0024 §1). 401 → `auth`, a
  JSON 403 → `forbidden`, 404 → `not_found`; everything else is a request `pd`
  composed itself and Pipedrive refused, which is a bug in `pd`. Ticket 07's
  eight remaining resources inherit this and add no classification of their own.
- **The reported cause of a rejected record is its first zod issue**, and a
  record that failed as a whole has `path: ""` (ADR-0024 §2). Reporting every
  issue would enter one fault under three deduplication keys.
- **`NdjsonWriter.error()` writes both of ADR-0001's channels** — the object to
  stdout and the one-line summary to stderr (ADR-0024 §3). It does not own
  stderr in general: ADR-0015's diagnostics and ADR-0003's every-10,000-records
  notice are ticket 17's, on a different channel.
- **`ListEnvelope` is hand-written and shared by every list endpoint**
  (ADR-0024 §4). The hoist worked and gives `zGetDealsItem` as the record
  schema, but the generated *envelope* is a `ZodIntersection` that fails as a
  whole, which is the failure ADR-0006 §2 split validation to prevent. An absent
  `additional_data`, and an absent, `null` or empty `next_cursor`, all end the
  walk; only a wrong-typed `next_cursor` is structural.
- **The prototype samples are generated by driving the shipped writer**, and
  `test/output-samples.test.ts` compares the committed files byte for byte.
  ADR-0002 made them the only guard against drift; this is what makes the guard
  mechanical. Regenerate with
  `bun run .scratch/pd-cli-design/prototypes/10-output-format/generate.ts`.
- **`--limit` mechanics are built, the flag is not.** ADR-0004's
  marker-may-not-lie table lives in `walk.ts` and is tested in
  `src/lib/pipedrive/walk.test.ts`; ticket 06 owes the flag, its validation, its
  acceptance tests and the whole of `--max-requests`.
- **`collect` ships unused**, with unit tests, exactly as ADR-0004 said it would.
- **The v2 record schemas are stricter than the live API.** `won_time`,
  `lost_time` and `expected_close_date` are non-nullable and required, while an
  open deal has none of them — so against a real account the first page is
  wholly rejected and the run is `invalid_response`. That is the patch-list task
  of ADR-0006 §9, it must be driven by observed responses rather than guesswork,
  and it is named in ADR-0024's consequences so the finding is recognised as
  expected work rather than as a bug in the walk.
- **A Bun bundler flake was found and worked around, in tests only.** Under
  `bun test`, `Bun.build` intermittently fails with `Could not resolve` on an
  import that plainly resolves — roughly one build in five to ten on Bun 1.3.14,
  only on the first build of a process, and naming a *random* module (the
  generated SDK on one run, `../errors.ts` on the next). It surfaced when this
  ticket grew the module graph. `bun run build` did not reproduce it in fifteen
  consecutive runs, so the artifact is sound and the test was flaky.
  `test/support/build.ts` retries the build up to three times; `scripts/build.ts`
  is untouched, because a retry there would swallow the one failure a real build
  must report. Delete the helper when Bun fixes the resolver.
- **The trailerless-exit check covers the throw path, deliberately.** ADR-0004
  says a run that exits with no trailer surfaces as `internal`, "checked on
  process exit". `cli.ts` catches anything that escapes `main` — the writer's
  second-trailer refusal, `guardedFetch`'s carrier, a genuine bug — and writes
  the `internal` error line with zero counters. A run that *returns cleanly*
  without a trailer is not checked, because `stream()` is the only consuming
  loop and it always ends in `finish` or `error`; there is no path that returns
  0 with nothing written. A second loop written by hand is what would reopen
  this, and ADR-0004's answer to that is that there must not be one.
