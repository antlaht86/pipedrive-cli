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
