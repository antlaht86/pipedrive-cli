# How streaming pagination composes with `Result`

Type: grilling
Status: open

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
