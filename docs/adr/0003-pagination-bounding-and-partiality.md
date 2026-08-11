# ADR-0003: Pagination bounding and the partiality marker

Status: accepted
Date: 2026-08-11
Deciding ticket: [How pagination is bounded, and how partiality is signalled](../../.scratch/pd-cli-design/issues/11-grilling-pagination-bounding.md)

## Context

Complete pagination is a locked property of `pd`: "all deals" means all of them, across as many
cursor pages as it takes, and cursor handling is an internal detail the caller never sees. That
leaves two questions this ADR answers — what bounds a run, and how the caller learns it received
less than everything.

Three earlier decisions constrain the shape and are not reopened here:

- [ADR-0001](0001-error-model-and-exit-codes.md) fixed that a **bound** the caller asked for exits
  `0`, a **guard** they merely tolerated exits `3`, and that a completeness marker is present on
  every list output, always — including a fully successful one.
- [ADR-0002](0002-output-format.md) gave that marker a home: a run ends with exactly one trailer
  line, and **the last line always carries `complete` and `emitted`**, whether it is a `summary` or
  an `error`.
- [Cursor pagination research](../../.scratch/pd-cli-design/research/02-cursor-pagination-semantics.md)
  found that cursor lifetime and stability are entirely undocumented, that the cursors look like
  keyset markers rather than snapshot handles, and that v2 reports no total count anywhere.

## Decision

### One bounding flag: `--limit <n>`, counted in records

`--limit` is a **record count**, never a page size. There is no `--max-pages` and no `--all`.

`--max-pages` was rejected because it would expose exactly the abstraction the locked pagination
property promises to hide: an agent that asks for 3 pages cannot know whether it will receive 300
records or 1,500. Page size stays internal and fixed at the v2 maximum of 500. `--all` was rejected
as redundant — the default is already everything.

`--max-requests <n>` is unaffected by this ADR. It remains a guard, not a bound, and keeps the exit
code and `code` value ADR-0001 gave it.

### The default is everything, and the warning is on stderr

With no bounding flag, `pd` fetches the complete set. This follows from the locked property; a
default ceiling would silently lie to a caller who asked for all deals.

The risk that creates is an agent blowing its context on a 40,000-record answer, and it is
addressed in two places, neither of which touches stdout:

- `AGENTS.md` instructs an agent to pass `--limit` unless it knows the result set is small.
- An unbounded run writes a warning to **stderr** on crossing 10,000 emitted records, and again on
  every subsequent 10,000. The run continues; the lock holds.

The threshold counts records rather than pages, because an agent's context is consumed by records
and because a page is a locked-away internal concept. It is documented in `AGENTS.md` and is **not
configurable** — a configurable warning threshold is a switch nobody ever turns.

### `reason` appears only on a bounded `summary`

Every guard stop ends the run with an `error` line carrying a `code`, so `reason` can never appear
alongside one. `reason` therefore belongs exclusively to a `summary` line with `complete: false`,
and its value set is exactly the set of bounds — today, the single value `"limit"`.

The field is kept despite having one value. A future bound (a `--since` cutoff, say) then arrives as
an additive change rather than a breaking one. This is the same reasoning that made ADR-0001 carry
`retry` explicitly instead of deriving it.

This also settles the ticket's question of whether every way of stopping early reports partiality
the same way. It does: the last-line invariant is total, and the discriminator is `type` plus
`code` or `reason`.

| Cause of stopping | Trailer | Discriminator | Exit |
| --- | --- | --- | --- |
| Everything fetched | `summary`, `complete: true` | — | `0` |
| `--limit` reached | `summary`, `complete: false` | `reason: "limit"` | `0` |
| `--max-requests` reached | `error` | `code: "request_ceiling"` | `3` |
| Daily budget exhausted | `error` | `code: "budget_exhausted"` | `3` |
| Burst exhausted, retries spent | `error` | `code: "rate_limited"` | `3` |
| Cloudflare block | `error` | `code: "blocked"` | `3` |
| Failure mid-stream | `error` | the matching `code` | `1` |

### `emitted` counts lines written, and `--limit` is applied after filtering

`emitted` is the number of `record` lines that reached stdout. Nothing else. The name promises that,
and a count of records *fetched* would make a caller reconcile a number against output it can see.

`--limit` is counted against the same number, **after** zod rejection and after cross-page
deduplication. `--limit 100` keeps fetching pages until 100 valid records have been written or the
data runs out. Counting before filtering would let an agent ask for 100 and receive 97 with no
explanation.

Two further fields make the difference between fetched and emitted auditable:

```
{"type":"summary","complete":true,"emitted":100,"skipped":3,"duplicates":0}
{"type":"summary","complete":false,"emitted":100,"skipped":0,"duplicates":2,"reason":"limit"}
```

- `skipped` — records rejected by zod, each of which already emitted its own `warning` line.
- `duplicates` — records suppressed by cross-page deduplication.

Both are always present on a list command's trailer, `0` when nothing was dropped.

### The bookkeeping fields ride on the `error` line too

`skipped` and `duplicates` join `complete` and `emitted` on the `error` trailer. A run that died
mid-stream has measured them just as truly as one that finished, and forcing the caller to infer
which fields exist from the trailer's `type` would break ADR-0001's promise that failure comes in
the same shape family as success.

A `usage` error carries all four as zeroes, exactly as ADR-0002 already accepted for `emitted` —
the vacuous case is cheaper than the special case.

### There is no resumption token

A run that stopped early cannot be continued. To go further, the caller raises the ceiling or the
limit and runs the command again.

An opaque `resume_token` on the trailer was rejected. It would have to be a cursor, and the research
found cursor lifetime and stability undocumented with keyset-like behaviour — so a resumed walk may
skip records that moved and duplicate records that changed, without any way to detect that it did.
Publishing a token would be promising semantics Pipedrive does not offer, and a silent missing
record is worse than a re-run. A guarantee `pd` cannot keep is not a feature.

### Deduplication state is unbounded

Cross-page deduplication holds a `Set` of every id seen for the whole run, with no cap and no
sliding window. ADR-0002's prototype measured 40,000 records at 110 MB peak RSS, against which a set
of numeric ids is a small fraction; a million ids is on the order of tens of megabytes.

A sliding window would trade a firm guarantee for a silent duplicate, which is precisely the failure
mode keyset cursors already threaten. If memory ever does run out, that surfaces as `internal` — a
loud failure rather than a quiet wrong answer.

### `--limit` validation, and where the flag exists

`--limit` requires a positive integer of 1 or greater. `0`, a negative number, a float and a
non-numeric value are all `usage` errors with exit `2`. There is no upper bound; an upper bound
would be a second, arbitrary ceiling stacked on the default.

`--limit` **does not exist on non-list commands**. Passing it to `pd deal get 42` is a `usage`
error, not a silently ignored flag. The command manifest lists `--limit` only under list commands,
so a harness discovers this instead of probing for it.

## Consequences

- **ADR-0001 needs a wording correction.** Its `request_ceiling` row advises the caller to "raise
  the ceiling or resume". Resumption does not exist, so that row now reads: raise the ceiling and
  run again.
- `--limit` counting after filtering means the number of HTTP requests a bounded run makes is not
  derivable from the limit alone. A result set with many rejected records costs more pages than a
  clean one. This interacts with `--max-requests`, and a run may hit the guard before the bound.
- `skipped` and `duplicates` become part of the stable output contract, joining `complete` and
  `emitted`. They may not be removed without a breaking change.
- The prototype's sample files under
  [`.scratch/pd-cli-design/prototypes/10-output-format/`](../../.scratch/pd-cli-design/prototypes/10-output-format/)
  predate the two new fields and no longer match the normative trailer shape. They are the only
  guard against format drift under ADR-0002, so they must be regenerated with `skipped` and
  `duplicates` present.
- For the same reason, the inline example lines in ADR-0001 and ADR-0002 predate `skipped` and
  `duplicates` and are therefore incomplete. **The trailer shape declared here supersedes them.**
  Those ADRs are accepted and are not rewritten retroactively; this note is the reconciliation.
- Any future bound must be added as a new `reason` value and must exit `0`, or it is a guard and
  belongs in the error union instead. The two categories are not interchangeable.
