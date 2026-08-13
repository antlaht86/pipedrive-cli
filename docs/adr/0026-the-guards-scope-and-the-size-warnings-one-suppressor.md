# ADR-0026: The guard's scope across verbs, and the size warning's one suppressor

Status: accepted
Date: 2026-08-13
Deciding ticket: [`--limit` and `--max-requests`](../../.scratch/pd-impl/issues/06-limit-and-max-requests.md)
Extends: [ADR-0003](0003-pagination-bounding-and-partiality.md) §"`--limit` validation, and where the flag exists" — which scoped the bound and left the guard unscoped
Extends: [ADR-0010](0010-budget-guard.md) §3 — the guard is defined over a run, and every verb is a run

## Context

[ADR-0003](0003-pagination-bounding-and-partiality.md) settled the bound/guard
distinction and stated where `--limit` exists: list commands only, and passing
it anywhere else is a `usage` error rather than a silent no-op. It said nothing
about where `--max-requests` exists, and ticket 06 had to answer that to write
the option table.

The second question is the same shape. ADR-0003 requires a stderr warning on
crossing every 10,000 emitted records "with no bounding flag", which decides
`--limit`'s effect on it and leaves `--max-requests`'s undecided.

Both are small, and both are the sort of thing a later ticket would otherwise
answer differently by accident.

## Decision

### 1. `--max-requests` exists on every data command; `--limit` still does not

The guard is on `list` and on `get`, and will be on `search` when ticket 14
arrives. The bound stays list-only, exactly as ADR-0003 fixed it.

The two flags are scoped differently because they are about different things.
`--limit` is a record count, and a `get` returns one record by construction —
the flag would have nothing to bound, which is why ADR-0003 made it a usage
error rather than a no-op. `--max-requests` is defined by
[ADR-0010](0010-budget-guard.md) §3 over the requests a **run** makes, and a
`get` is a run: it dispatches, it retries on a 5xx, and a caller who wants a
ceiling over that has the same reason to want it as on a walk.

The alternative — the guard on list only — would make the flag's presence
depend on the verb for no reason the caller could state, and would mean an
agent that adds `--max-requests` to every invocation as a matter of policy gets
a usage error for its trouble on half of them.

The refusal an unrecognised flag earns therefore names a **per-verb** flag list:
`pd deals get --limit 5` reads *It takes `--token-file` and `--max-requests` and
no other flag*. One wording, filled from the table that builds the parser, so
the message cannot drift from what the command accepts.

### 2. The size warning is suppressed by `--limit`, and by nothing else

ADR-0003's warning fires on crossing each 10,000 emitted records. `--limit`
suppresses it: the caller stated how much output it wanted, and telling it that
it received what it asked for is noise on the one channel a human is reading.

`--max-requests` does **not** suppress it. It is a guard, not a bound — it says
what the caller would tolerate spending, not how much output it expects — and a
run that emits 40,000 records under a generous ceiling is exactly the case the
warning exists for.

The warning stays on stderr, stays uncounted by the trailer, and stays
unconfigurable and uninjectable. A threshold with a knob is a switch nobody ever
turns, and a threshold with a *test-only* knob is the surface
[ADR-0019](0019-testing-strategy.md) §5 forbids; the unit test drives 20,001
records through the writer instead.

### 3. Headroom is reserved, not measured, and the reservation counter is the trailer's

The guard takes its slot synchronously at the top of the retry loop, ahead of
the burst gate's first `await`. Two properties follow, and neither is
incidental:

- **Concurrent requests cannot overspend it.** Four in-flight walkers under a
  ceiling of two cannot each read the same last slot, because nothing yields
  between the test and the increment.
- **A retry spends headroom.** [ADR-0011](0011-concurrency-and-retry.md) §9
  counts every attempt as a request, so a retried 5xx passes the reservation
  point again. A ceiling a retry storm could walk past would not be a ceiling.

One counter serves as both the reservation and the trailer's `requests`, because
a reservation is always followed by a dispatch — nothing between the two can
decline. So `requests` on a `request_ceiling` trailer equals the ceiling
exactly, and the guard aborts *before* it is exceeded rather than after.

## Consequences

- **`pd <resource> get <id> --max-requests <n>` is a documented command shape.**
  Ticket 16's manifest lists the flag under both verbs, and `--limit` under
  `list` alone.
- **The unknown-flag message is now verb-dependent.** Two tests asserted its
  exact wording against the old single-flag list and were updated; the normative
  sample `f-usage-error.ndjson` was regenerated in the same commit, which is
  ADR-0002's drift gate working as designed.
- **A large `--limit` is silent.** `--limit 500000` emits 40,000 records with
  nothing on stderr, because the caller named the ceiling it wanted. Accepted:
  the warning exists to catch a run whose size nobody chose, and a number the
  caller typed is a number the caller chose.
- **The warning does not claim the walk continues.** The threshold can be met by
  the last record of a complete run, so the line reports the count and the
  remedy rather than asserting a state it cannot know at that moment.
- **`request_ceiling`'s `details` gained a `path`**, naming the request that met
  the ceiling. `details` is explicitly unstable and may not be branched on, so
  this is additive by definition.
- Nothing here changes an output line shape or a `code`, so `manifest_version`
  does not move.
