# How pagination is bounded, and how partiality is signalled

Type: grilling
Status: resolved

Blocked by: 02, 10

## Question

Complete pagination is locked — "all deals" means all of them. So what bounds a run, and how does the agent learn it got less than everything?

- Which of `--limit`, `--max-pages`, `--all` exist, and what each means precisely. Is `--limit` a record count or a page size? Page size is an internal detail under locked point 5, so a user-facing `--limit` that means page size is probably wrong.
- What the default is with no bounding flag. Everything, or a safe ceiling? An agent that asks for all deals on a large account and gets 40,000 records has blown its context; an agent that silently gets 100 has been lied to.
- Every way a run can stop early: the record or page bound, `--max-requests`, budget exhaustion, burst exhaustion after retries, a mid-stream failure. Do they all report partiality the same way?
- The partiality marker itself: what it contains beyond a boolean. A reason, a count of what was returned, and — if ticket 02 found cursors are stable enough — a resumption cursor.
- Whether a partial result exits 0 or non-zero, and whether that differs by the reason it stopped. This must agree with ticket 09.
- Whether a resumption cursor is exposed to the caller, given that locked point 5 says cursor handling is an internal detail the agent never sees. Is a resumption token a cursor, or an opaque thing that happens to be one?

Record as an ADR.

## Context added while resolving other tickets

- [The error union, exit codes, and machine-readable failure](09-grilling-error-union-and-exit-codes.md) fixed the exit-code semantics this ticket builds on: a **bound** the caller asked for exits 0, a **guard** they merely tolerated exits 3, and the **completeness marker is present on every list output, always** — including a fully successful one. This ticket decides the marker's contents, not whether it exists.
- [ADR-0002](../../../docs/adr/0002-output-format.md) gave the completeness marker a concrete home: the run ends with exactly one trailer line, `{"type":"summary","complete":…,"emitted":…}` on success or a `type: "error"` line on failure, and the last line always carries `complete` and `emitted` whichever it is. This ticket decides the `reason` values on a bounded summary, and whether a resumption token appears on that line.
- [Cursor pagination semantics](02-research-cursor-pagination-semantics.md) makes the resumption question harder than charted: cursor lifetime and stability are **entirely undocumented**, and the cursors look like keyset markers rather than snapshot handles, so a resumed walk may skip or duplicate records that changed in between. There is also **no total count in v2**, so "you got 3,200 of N" cannot be expressed.

## Answer

Recorded in full as [ADR-0003](../../../docs/adr/0003-pagination-bounding-and-partiality.md).

**One bound, counted in records.** `--limit <n>` is the only bounding flag, and it counts records,
never pages. `--max-pages` is rejected because it exposes the page size that locked point 5 promises
to hide — 3 pages could be 300 records or 1,500. `--all` is rejected as redundant against a default
that already fetches everything. Page size stays internal at the v2 maximum of 500. `--max-requests`
is untouched and remains a guard.

**The default is everything, and the guard rail is on stderr.** `AGENTS.md` instructs an agent to
pass `--limit` unless it knows the set is small, and an unbounded run warns on **stderr** at 10,000
emitted records and every 10,000 after. The run never stops for it and stdout never sees it, so the
locked completeness property holds. The threshold counts records because records consume an agent's
context, and it is documented rather than configurable.

**`reason` is exclusive to a bounded `summary`.** Every guard stop ends in an `error` line carrying
a `code`, so `reason` can only ever appear on a `summary` with `complete: false`. Its value set is
exactly the set of bounds — today the single value `"limit"`. The field is kept at one value so a
future bound is an additive change, the same reasoning that made ADR-0001 carry `retry` explicitly.

This settles the ticket's third question: yes, every early stop reports partiality identically. The
last-line invariant is total; the discriminator is `type` plus `code` or `reason`.

**`emitted` counts lines written; `--limit` is applied after filtering.** `emitted` is the number of
`record` lines that reached stdout, nothing else. `--limit 100` keeps fetching until 100 valid
records are written or the data runs out — counting before filtering would let an agent ask for 100
and silently receive 97. Two new always-present fields make the gap auditable: `skipped` (zod
rejections, each of which already emitted a `warning`) and `duplicates` (suppressed by cross-page
deduplication). Both ride on the `error` trailer as well as the `summary` one, so failure keeps the
same shape family as success.

**No resumption token.** A run that stopped early cannot be continued; the caller raises the limit
or the ceiling and runs again. A token would have to be a cursor, and ticket 02 found cursor
lifetime and stability undocumented with keyset-like behaviour — a resumed walk may skip and
duplicate silently. Promising semantics Pipedrive does not offer is worse than a re-run.

**Deduplication state is unbounded** — a `Set` of every id seen, no window. ADR-0002 measured 40,000
records at 110 MB RSS, against which numeric ids are a small fraction. A sliding window trades a
firm guarantee for a silent duplicate, the exact failure keyset cursors already threaten. Exhaustion
surfaces as `internal`, loudly.

**`--limit` validation**: positive integer ≥ 1; `0`, negative, float and non-numeric are `usage`,
exit 2. No upper bound. The flag does not exist on non-list commands — passing it to `pd deal get 42`
is a `usage` error, and the manifest lists it only under list commands.

### Follow-on work this creates

- ADR-0001's `request_ceiling` row said "raise the ceiling or resume". Corrected in place.
- The prototype sample files under `prototypes/10-output-format/` predate `skipped` and
  `duplicates` and no longer match the normative trailer. Under ADR-0002 they are the only guard
  against format drift, so they must be regenerated. Folded into ticket 22.
