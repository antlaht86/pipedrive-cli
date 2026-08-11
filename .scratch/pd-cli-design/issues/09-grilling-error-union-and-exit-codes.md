# The error union, exit codes, and machine-readable failure

Type: grilling
Status: resolved

## Question

What variants does the typed error union carry, and how does an agent act on a failure without parsing prose?

- Enumerate the variants. Candidates: usage error, authentication failure, authorization failure, resource not found, rate limit or burst exhausted, daily budget exhausted, `--max-requests` ceiling reached, network or transport failure, schema validation failure, upstream 5xx, cache corruption, partial result. Which of these are genuinely distinct in how a caller must respond, and which collapse together?
- How each variant maps onto the four fixed exit codes (0, 1, 2, 3). Several variants must share a code — what does the agent read to tell them apart?
- How retryable is expressed. A boolean on the variant, a separate classification, or implied by the variant? Where does "retryable after a delay" carry that delay?
- The machine-readable error payload: where it goes (stdout is machine output only, stderr is diagnostics — so which?), its shape, whether it is stable across versions, and whether it is emitted on every failure or only some.
- Whether a partial success is a failure at all, or a success with a partiality marker. This decision constrains the pagination-bounding ticket.
- What a programmer error looks like by contrast, given that throwing is reserved for it.

Nothing else in the design can be shaped until failure has a shape. Record as an ADR.

## Answer

Recorded in full as [ADR-0001: Error model, exit codes and machine-readable failure](../../../docs/adr/0001-error-model-and-exit-codes.md).

In gist:

- The machine-readable error object goes to **stdout**, same channel and shape as success output, usage errors included. stderr gets a human one-liner. Rationale: harnesses treat stderr inconsistently, and a mid-stream failure needs to land in causal order after bytes already written.
- **Eleven variants**, each earning its place by a distinct caller response. Cache corruption is not among them — `pd` evicts and refetches instead.
- Exit codes stay coarse; `code` — whose value is the variant name — is the branchable interface. `message` is human-facing and free to change. The mapping table ships in the command manifest.
- An **ambiguous 429 is treated as `budget_exhausted`** and stops the run, because mistaking budget for burst produces a retry loop that escalates to a company-wide Cloudflare block. `blocked` is its own variant, and forces the rule that a response is never assumed to be JSON.
- **Bounds exit 0, guards exit 3.** A completeness marker rides on every list output, always, not only on failure.
- **`retry`** has three values (`never`, `after`, `not_today`) and answers only whether repeating the identical command will succeed. Its real job is making a newly added variant a non-breaking change.
- Internal retry touches transport failures, 5xx and inferred-burst 429s; it never touches an ambiguous 429 or a Cloudflare 403. Concrete numbers are left to the concurrency ticket.
- The error object's stable surface is four always-present fields plus an explicitly unstable `details` box that nothing may branch on and into which URLs are redacted. No version number in the payload.

Two things this resolution hands onward:

- **Retry state is process-scoped**, so an agent calling `pd` fifty times in a loop gets fifty fresh caps, each ignorant of the last. This is the same cross-invocation state problem the budget guard faces; noted on that ticket.
- The read-only property turned out to rest solely on `pd`'s own code when an API token is used. Raised as [How the read-only property is actually enforced](23-grilling-read-only-enforcement.md).
