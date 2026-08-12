# Default concurrency for the p-limit limiter

Type: grilling
Status: open

Blocked by: 01

## Question

What number, and is it configurable?

- Derive a default from ticket 01's burst window and allowance rather than picking a familiar number. Show the arithmetic.
- Whether one limiter is enough, given the Search API has stricter limits. One limiter tuned to the strictest endpoint wastes throughput everywhere else; per-endpoint limiters add state to the client module.
- How the limiter and the retry logic interact. A 429 that triggers a retry inside a saturated limiter can queue behind more requests that will also 429 — does the limiter need to back off as a whole rather than per request?
- Whether the concurrency is configurable by flag or environment variable, and what a user raising it can break. Given the shared budget, is a user-raisable concurrency a hole in the safety story, and should there be a hard maximum regardless of the flag?
- Whether concurrency is even useful for a single cursor walk, which is inherently sequential — each page needs the previous page's cursor. Identify where concurrency actually helps: multiple entity types, per-record enrichment, field schema fetches across entities. If cursor walks are the dominant workload, the default matters less than it appears.

Record as an ADR.

## Context added while resolving other tickets

- [ADR-0010](../../../docs/adr/0010-budget-guard.md) hands this ticket the whole of retry policy in
  numbers. There is **no daily token ledger and no token ceiling**, so nothing outside this ticket
  bounds request volume except `--max-requests`, which has no default. The concrete burst-retry counts,
  delays and caps ADR-0001 deferred are therefore yours alone to set, and they are the loop that
  escalates into a Cloudflare block if set too loosely.
- The internal retry cap stays **process-scoped** by decision, not by omission. ADR-0010 §8 argues it is
  safe because ADR-0001 already forbids retrying the two escalating situations, and because a fresh
  invocation is realistically further apart than the 2-second burst window. If the concurrency numbers
  chosen here make that second half untrue, this ticket must say so.
- A `blocked` outcome now writes a sentinel that suppresses the next 15 minutes of invocations for that
  credential (ADR-0010 §6). Whatever backoff is chosen must reach `blocked` rather than looping short
  of it, or the sentinel never gets written.
