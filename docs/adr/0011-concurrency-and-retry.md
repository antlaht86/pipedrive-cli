# ADR-0011: Concurrency, the burst gate, and the retry numbers

Status: accepted
Date: 2026-08-12
Deciding ticket: [Default concurrency for the p-limit limiter](../../.scratch/pd-cli-design/issues/17-grilling-concurrency-default.md)
Settles the retry counts, delays and caps deferred by [ADR-0001](0001-error-model-and-exit-codes.md) and handed here by [ADR-0010](0010-budget-guard.md) §8

## Context

Locked point 3 requires `p-limit` on all concurrent HTTP work, and locked point 7 puts every HTTP call
through one client module. This ADR sets the number, decides whether anyone may change it, and — because
[ADR-0010](0010-budget-guard.md) removed every other bound on request volume except `--max-requests`,
which has no default — fixes the retry policy that would otherwise be the loop that escalates into a
Cloudflare block.

Three facts from [the rate limiting research](../../.scratch/pd-cli-design/research/01-rate-limits-and-token-budget.md)
frame it:

- Burst is a **request** counter on a rolling **2-second** window, per token: 20 req/2 s on Lite rising
  to 120 on Ultimate for api_token.
- **`pd` cannot read the plan tier.** No documented endpoint reports it, so the ceiling must be assumed.
- Continuing to send traffic after a 429 earns a Cloudflare 403 that blocks the whole company's
  api_token traffic.

### Concurrency helps far less than the ticket assumed

The ticket asked whether concurrency is even useful for a cursor walk. It is not, and the walk is the
dominant workload. Against [ADR-0009](0009-command-surface-and-manifest.md)'s surface — `pd <resource>
<verb> [id]`, one resource per invocation — the parallelisable work is:

| Work | Parallelisable | Size |
| --- | --- | --- |
| Cursor walk | **No** — each page needs the previous page's cursor | up to 80 requests |
| Cold `--resolve` metadata: the entity's field schema, `users`, `pipelines`, `stages` | Yes | 4 requests, once per run |
| `--resolve` relation batches, 100 ids per request ([ADR-0008](0008-resolution-mechanics.md)) | Yes | a handful per page, ≤ `--resolve-budget` |

So concurrency touches enrichment only. On the path that spends the most requests it does nothing at
all, and the default matters much less than the ticket's framing suggested.

## Decision

### 1. `p-limit` cannot protect the burst window, so a rate gate sits beside it

`p-limit` bounds **in-flight** requests; the burst limit is a **rate**. The two are not the same
quantity and no concurrency value converts one into the other. At a 150 ms round trip, concurrency 2
already issues ~26 requests per 2 seconds — over Lite's 20 — while concurrency 8 against a 4-second
round trip stays under it. The binding factor is latency, which `pd` does not control.

The client module therefore runs a **rolling 2-second rate gate** in front of the limiter. Every
request acquires a gate slot and a limiter slot; the gate is the safety mechanism and `p-limit` merely
caps how much work is in the air at once. Locked point 3 mandates `p-limit`; it does not forbid a gate
beside it, and without one the locked requirement would not deliver the property it exists for.

### 2. The gate is set at half the assumed window: 10 requests per 2 seconds

The assumed ceiling is the smallest documented plan, **Lite, 20 req/2 s**, because the plan tier is
unreadable and guessing high is the guess that escalates.

`pd` takes **half** of it. Burst is per token, and that token may be driving other scripts; a tool that
consumes the entire allowance of a credential it shares makes everything else on that credential start
eating 429s, and cannot see that it is the cause. The cost is confined to enrichment: a sequential
cursor walk issues one request at a time and is paced by latency long before the gate binds.

### 3. The concurrency default is 4, derived

- The gate allows 10 req / 2 s = **5 req/s**.
- Concurrency only needs to be large enough that the **gate**, not `p-limit`, is the binding
  constraint: `N = rate × round-trip`. At 5 req/s, **N = 4** saturates the gate for any round trip at
  or above 800 ms. Below that the gate binds first and the concurrency value is irrelevant.
- 4 is also the largest genuinely independent fan-out anywhere in the design — the four cold
  `--resolve` metadata fetches of §Context. No code path has more independent work waiting on it than
  that at any one moment.

A larger number buys nothing: it cannot raise throughput above the gate, and there is no workload with
more than a handful of independent requests. This is the arithmetic the ticket asked for, and it lands
on 4 rather than on a familiar 5 or 8.

### 4. There is no flag, no environment variable, and no knob of any kind

Concurrency and the gate are internal constants. They appear in no `--help` text, in no `pd manifest`
output, and read from no environment variable.

The map's safety property is that an agent must be unable to damage things through this tool. A
`--concurrency` flag is a documented lever toward a shared burst limit, advertised by `--help` to
precisely the consumer it should be hidden from. A lower-only flag was considered and rejected as
well: it preserves the safety story but costs a manifest entry, an `AGENTS.md` paragraph and a usage
error that agents will discover by trying to raise it — real surface bought for a knob nobody has
asked for.

The trade accepted: a human on an Ultimate plan never gets their 6× headroom out of `pd`. Per §Context
that costs seconds on enrichment and nothing at all on a walk. If it ever matters, reopening this is
one constant and one flag.

### 5. The gate adapts upward from `x-ratelimit-limit`, and never downward

`x-ratelimit-limit` is documented as "the maximum number of requests current access_token or api_token
can perform per 2-second window" — the one plan signal `pd` can actually read. When a response carries
a value above the assumed 20, the gate raises to **half of the observed value** for the remainder of
the process.

- **An absent header never lowers anything.** Research gap 13 records that whether the burst headers
  appear on all responses or only near the limit is undocumented, so absence carries no information.
  The Lite-derived floor of 10 req/2 s is a floor, never a current reading.
- **It is process-scoped and not cached.** [ADR-0005](0005-cache-design.md)'s list of five — since
  grown to eight by [ADR-0008](0008-resolution-mechanics.md) — is a closed list of near-static
  resources, and a rate ceiling learned from a header is not one of them. A fresh process starts at the
  floor and re-learns on its first response, which costs one conservative window and keeps
  [ADR-0010](0010-budget-guard.md)'s rule that the `blocked` sentinel is the only cross-invocation
  state.

### 6. A 429 pauses the whole gate, not the one request

When a burst 429 arrives, the gate stops admitting **every** request, in flight and queued, for the
backoff interval. Retrying only the failed request while its siblings continue is the exact shape the
ticket warned about: queued requests each earn their own 429 in series, and a stream of 429s ignored is
what research 01 found earns the Cloudflare 403 on the whole company's traffic.

This is also what makes [ADR-0010](0010-budget-guard.md) §6's sentinel reachable rather than
theoretical. A global pause converts a rate problem into at most one 429 per window; if a 403 does
arrive, it arrives to a client that is not simultaneously firing three more requests at it.

### 7. Burst retries: 3 strikes, run-level, roughly 6 seconds

[ADR-0001](0001-error-model-and-exit-codes.md) retries only a 429 *inferred as burst* — one carrying
`x-ratelimit-remaining: 0`, meaning the 2-second window is spent and nothing worse. A 429 inferred as
budget, or not inferable at all, still stops immediately as `budget_exhausted`.

- **Three strikes, counted per run, not per request.** §6 makes a 429 a whole-gate event, so it is a
  property of the run rather than of a request. Three consecutive spent windows means something other
  than `pd` is consuming the token's burst allowance, and a fourth wait will not fix that.
- **Each wait is `x-ratelimit-reset`, clamped to at most 2 seconds**, with a flat 2 seconds when the
  header is absent. Recorded as an assumption, not a fact: research gap 3 notes the unit of
  `x-ratelimit-reset` is undocumented — seconds, milliseconds or a timestamp. It is read as seconds,
  and the clamp makes the assumption harmless in every direction, because the window it describes is
  only 2 seconds wide.
- **Total added stall is therefore ~6 seconds**, then `rate_limited`, exit 3, `retry: "after"` with
  `retry_after_seconds`.

Patience beyond this was rejected on the harness: an agent tool call that sits silent for 30 seconds is
liable to be killed by its harness, and a `pd` that is killed reports nothing at all — the caller loses
the failure explanation that is the whole point of ADR-0001's error model.

The accepted cost is real and worth naming: [ADR-0003](0003-pagination-bounding-and-partiality.md)
gives no resumption token, so a transient collision 39,000 records into a 40,000-record walk ends that
walk. §2's half window is what makes the collision unlikely in the first place.

### 8. 5xx and transport failures: 3 attempts per request, 10 per run

[ADR-0001](0001-error-model-and-exit-codes.md) specified "exponential backoff, capped" and left the
numbers here.

- **Per request: 3 attempts**, with waits of 250 ms, 1 s and 4 s, full jitter applied to each.
- **Per run: 10 retries total**, across all requests. Then `upstream`, exit 1.
- **A separate counter from §7's strikes.** A 5xx is Pipedrive failing, not `pd` being too fast, and
  the two must not exhaust each other. Neither escalates to Cloudflare, which is why this budget can be
  more generous than the burst one.

The run-level cap is what stops an 80-page walk from turning 3 retries per page into 240 retries
against a service that is plainly down.

### 9. `--max-requests` headroom is reserved before dispatch

Every request takes its slot against `--max-requests` **before** it is sent, and releases nothing on
success. Counting on completion would let 4 parallel enrichment batches all pass a check showing 3
remaining, and locked point 4 calls the flag a hard ceiling that aborts *before* it is exceeded.

**Retries count.** Each attempt is a network request and is counted as one, per
[ADR-0005](0005-cache-design.md) §4's rule that the unit is network requests. A run that spends its
ceiling on retries has genuinely spent it.

This composes with [ADR-0008](0008-resolution-mechanics.md) §10 as promoted by
[ADR-0010](0010-budget-guard.md) §4: an enrichment reserves its whole batch or does not dispatch it,
so parallelism can never be the thing that trips a guard.

### 10. One limiter class now, keyed by endpoint family

The Search API's 10 req/2 s ceiling — uniform across all plans and all auth types — applies to nothing
`pd` currently does: [ADR-0009](0009-command-surface-and-manifest.md) shipped no search command, and
research 01 notes the membership of "the Search API" is inference from path names rather than a
documented list. Building a second limiter now would be state in the client module serving no caller.

The gate is nevertheless **keyed by endpoint family** internally, with every current operation in one
`default` family. Ticket 26 adds a `search` family at 10 req/2 s — halved to 5 by §2 — by adding a key,
not by reworking the module. The unresolved question research 01 recorded (gap 11: whether the search
allowance is carved out of the general one or separate from it) is ticket 26's to answer, and the
conservative reading — that a search request spends both — is the one to assume until observed.

## Consequences

- **Two `pd` processes fit Lite exactly; three do not.** At half a window each, two concurrent
  invocations spend 20 of Lite's 20. An agent fanning out three parallel `pd` commands can 429 itself,
  and nothing in `pd` can detect it — the gate is process-local, and [ADR-0010](0010-budget-guard.md)
  §2 already refused cross-invocation accounting. `AGENTS.md` should say plainly that parallel `pd`
  invocations against one credential are not free.
- **[ADR-0010](0010-budget-guard.md) §8's premise is confirmed rather than assumed.** It argued the
  process-scoped retry cap is safe because a fresh invocation is realistically more than a burst window
  away from the previous one's last request. The numbers here make it safe even when it is not: a fresh
  process adds at most 4 in-flight against a window it half-shares, so worst-case overlap reaches the
  ceiling rather than exceeding it. The cap stays process-scoped.
- **The client module gains one component and one piece of process state**: the rolling-window gate,
  and the learned ceiling from §5. Both live where locked point 7 requires and nowhere else.
- **`pd` gains no flag, no manifest entry and no `--help` line.** This is the first ticket to add
  nothing at all to the command surface.
- **The effective gate and concurrency belong in stderr diagnostics.** With no flag to report and a
  ceiling that changes mid-run under §5, a human debugging a slow command has no other way to see what
  paced it. Ticket 24 owns the shape.
- **Ticket 26 inherits a keyed gate and a named default**: the `search` family at 5 req/2 s under §2's
  halving, plus gap 11 to resolve.
- **The testing-strategy question in the map's fog gains a requirement.** The gate and both retry
  budgets are timing behaviour, so whatever replay layer is chosen must be able to drive the clock, or
  a test of the retry policy takes 6 real seconds to run.
