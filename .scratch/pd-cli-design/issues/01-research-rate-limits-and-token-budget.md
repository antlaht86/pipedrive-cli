# Pipedrive rate limiting and the shared daily token budget

Type: research
Status: resolved

## Question

What exactly governs how fast and how much `pd` may read from Pipedrive?

Establish, from Pipedrive's own documentation and API responses:

- How the token-based daily budget is calculated. What a request costs, whether cost varies by endpoint, method or `limit` value, and how the pool is sized per plan and per company account.
- The burst limit: the exact window, the allowance inside it, and whether it is per token, per user or per company.
- The Search API's stricter limits, and any other endpoint with its own ceiling.
- Which response headers report remaining budget, remaining burst allowance and reset time. Exact header names and value semantics — this is what reactive budget accounting reads.
- The 429 response: body shape, `Retry-After` or equivalent, and whether daily-budget exhaustion is distinguishable from burst exhaustion by anything other than prose.
- Whether the budget is readable without spending a request.

Record header names and numbers verbatim. Later tickets on the budget guard, cache and concurrency default all depend on these being facts, not recollections.

## Answer

Findings: [research/01-rate-limits-and-token-budget.md](../research/01-rate-limits-and-token-budget.md).

**No response header reports the remaining daily token budget.** All four documented headers are burst-window headers or a POST/PUT-only counter. Budget accounting for `pd` must therefore be client-side and predictive — a cost table multiplied by a request count — not header-driven. This contradicts the premise this ticket was written on, and it is the single most consequential finding for the budget guard.

Budget formula, verbatim: `30,000 base tokens × subscription plan multiplier × number of seats (+ purchased API Token top-ups)`, shared across the whole company account, reset "at midnight at server's timezone" — and **the server timezone is never named**, so a reset countdown cannot be computed.

Cost is **flat per operation**, carried in the spec as the `x-token-cost` extension. It does not vary with `limit`, so 500 records cost the same as 1. v2 costs **half** of v1 for the common shapes (list 10 vs 20, single 1 vs 2, search 20 vs 40).

Burst is a **request** counter on a rolling 2-second window, separate from the token budget: 20–120 req/2 s for API tokens by plan, 10 req/2 s uniformly for the Search API.

**The 429 is nearly opaque.** Its body shape is undocumented, `Retry-After` is never mentioned, and neither published OpenAPI document declares a 429 on any operation — so the generated client has no type for it. Daily exhaustion and burst exhaustion are **indistinguishable by anything documented**.

**Cloudflare escalation is a real hazard**: continuing to hammer after a 429 earns a 403 whose body is an **HTML** error page, blocking the whole company's `api_token` traffic. A client that assumes JSON on every response will misparse it.

Thirteen documented gaps are listed in the findings file; several can only be closed by observing a real response.
