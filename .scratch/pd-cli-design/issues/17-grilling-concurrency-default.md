# Default concurrency for the p-limit limiter

Type: grilling
Status: resolved

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

## Answer

Full detail in [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md).

The ticket's last bullet was the one that mattered: concurrency is close to useless here. Against
ADR-0009's one-resource-per-invocation surface, the cursor walk is the dominant workload and is
sequential by construction; the only parallelisable work is the four cold `--resolve` metadata fetches
and the relation batches. So the default matters far less than the ticket assumed.

**`p-limit` cannot deliver the property it was locked in for.** It bounds in-flight requests; the burst
limit is a rate, and latency converts between them. At a 150 ms round trip, concurrency 2 already
exceeds Lite's 20 req/2 s. The client module therefore runs a **rolling 2-second rate gate** beside the
limiter, and the gate is the safety mechanism.

**The numbers, derived rather than picked.** The assumed ceiling is Lite, 20 req/2 s, because the plan
tier is unreadable. `pd` takes **half** — 10 req/2 s = 5 req/s — since burst is per token and the token
may drive other scripts. Concurrency then only needs to make the gate the binding constraint:
`N = 5 req/s × 800 ms` = **4**, which is also the largest independent fan-out anywhere in the design.
The gate raises itself to half of any larger `x-ratelimit-limit` it observes, process-scoped and never
cached; an absent header never lowers the floor.

**No flag, no environment variable, no manifest entry.** A `--concurrency` knob is a documented lever
toward a shared burst limit that `--help` advertises to the consumer it should be hidden from. The
lower-only variant was rejected as surface bought for nothing. First ticket to add nothing at all to the
command surface.

**Retry policy, which ADR-0001 deferred and ADR-0010 handed here.** A 429 pauses the **whole gate**,
not the one request, so queued siblings cannot each earn their own 429 in series and march toward the
Cloudflare 403. Burst retries are **3 strikes, counted per run** (a whole-gate event is a run property),
each waiting `x-ratelimit-reset` clamped to 2 s — recorded as an assumption, since research gap 3 leaves
the unit undocumented — for ~6 s of stall, then `rate_limited`. Longer was rejected on the harness: a
`pd` killed by a 30-second tool timeout reports nothing at all. 5xx and transport get their own separate
budget: 3 attempts per request at 250 ms / 1 s / 4 s jittered, capped at 10 per run.

`--max-requests` headroom is **reserved before dispatch**, retries included, or four parallel enrichment
batches sail past a ceiling ADR-0010 §3 calls hard.

**ADR-0010 §8's premise is confirmed, not assumed.** A fresh process adds at most 4 in-flight against a
window it half-shares, so worst-case overlap with a previous invocation reaches Lite's ceiling rather
than exceeding it. The retry cap stays process-scoped. The flip side is the honest consequence: two
concurrent `pd` processes fit Lite exactly, three do not, and nothing in `pd` can see that.

Search gets one line rather than a second limiter: ADR-0009 shipped no search command, so the gate is
keyed by endpoint family with everything in `default`, and ticket 26 adds a `search` key at 5 req/2 s.
