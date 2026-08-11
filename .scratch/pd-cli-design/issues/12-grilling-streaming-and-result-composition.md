# How streaming pagination composes with `Result`

Type: grilling
Status: resolved

Blocked by: 06, 09, 10, 11

## Question

What is the internal type of a paginated read, and what does a mid-stream failure do to output already written?

- The candidates: an async generator yielding `Result<Page, E>` per page; a `ResultAsync` over the whole collection; a generator of records with the error surfaced out of band; something else. Argue them against each other on ergonomics for the call sites and on what they permit at the output boundary.
- A `ResultAsync` over the whole collection cannot stream — it must resolve before anything is written. Does that alone disqualify it, given ticket 10's answer?
- With a per-page `Result`, what does the consumer do on the first `Err`? Stop, or continue and collect? Does that differ between a transport failure and a validation failure on one record?
- The hard case: bytes are on stdout, then page seven fails. Options include emitting a partiality trailer and exiting non-zero; buffering everything so this cannot happen; writing to a temporary buffer and committing atomically. Each trades time-to-first-byte against never emitting a truncated document.
- Whether stdout is ever allowed to hold an incomplete document, and what an agent that reads a truncated JSON array is supposed to do.
- Where the retry and rate-limit logic sits relative to this — inside the page loop, or inside the client module beneath it. Locked point 7 says the client module, so confirm the generator never sees a retryable failure at all.

Record as an ADR.

## Context added while resolving other tickets

- [ADR-0002](../../../docs/adr/0002-output-format.md) answered the mid-stream failure question **for the format**: records already written stay written, and the run ends with a single `type: "error"` trailer carrying `complete: false` and `emitted`. stdout is therefore explicitly allowed to hold a partial result — but never an incomplete *document*, since NDJSON has none. This ticket owns the control flow that produces it.
- The same ADR notes that a buffered NDJSON writer is byte-identical to a streaming one, so the internal type may ship buffered and become streaming later without a contract change. That weakens the case for `ResultAsync` over the whole collection rather than settling it: it removes the "we can decide later" excuse for buffering, since the later switch is free either way.
- Streaming was accepted as irreversible: once bytes are out they cannot be retracted. Any command needing whole-set post-processing is a second output path, and this ticket should say what that path looks like if it exists.

## Answer

Recorded in full as [ADR-0004](../../../docs/adr/0004-streaming-and-result-composition.md).

- **The internal type** is `AsyncGenerator<Result<Page, PdError>>` — a per-page `Result`.
  `ResultAsync` over the whole collection is rejected as the primary type: ADR-0002 measured 20 s of
  silence to first byte with no memory saving, and removed the "decide later" excuse. The variant
  that yields plain pages and returns the terminal `Result` was rejected too — it encodes the
  invariant in the type, but `for await` discards a generator's return value, so every call site
  would have to drive the iterator by hand.
- **The generator owns validation, deduplication and the `--limit` stop**, because ADR-0003 counts
  `--limit` in emitted records, so the decision to fetch another page depends on what survived
  filtering. It yields only clean, deduplicated, bounded pages.
- **The exactly-one-trailer invariant is guarded at runtime, not by the type.** One `NdjsonWriter` is
  the sole writer to stdout, holds `emitted`/`skipped`/`duplicates`, and refuses a second `finish`;
  a run that ends with no trailer is `internal`.
- **`bound: "limit"` rides on the final page**, so the writer's `emitted` is the only cumulative
  record count in the process. Inferring the bound from `emitted === limit` was rejected: it reports
  `complete: false` for a set holding exactly `limit` records. The generator resolves the same
  coincidence itself: a limit that fills at a page boundary with a `null` cursor ends the run
  `complete: true`, and every other case is `bound: "limit"` — conservative, because a keyset cursor
  cannot be known to be exhausted without fetching.
- **A page is atomic** — `Ok` page or terminal `Err`, never half a page. Sub-question 3 dissolves:
  a validation failure is never the walk's `Err` (it is a `warning` plus `skipped`), and a transport
  failure is terminal because the trailer is exclusive and there is no resumption.
- **Retry placement confirmed**: the generator never sees a retryable failure. Backoff, the 429
  inference and the Cloudflare stop live beneath it in the one client module, per locked point 7.
- **The second output path is specified**: `collect` drains the same generator and reuses the same
  writer, so the format cannot diverge. On failure it emits `emitted: 0` and writes none of the
  records it holds — half a sorted list is a wrong answer, not a partial one. Consequence: in the
  collected path, `warning` lines precede every `record` line.
- **Single-resource commands use the same writer** and emit a `summary` with `emitted: 1`, keeping
  the trailer shape from varying by command class.
