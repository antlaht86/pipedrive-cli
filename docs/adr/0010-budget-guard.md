# ADR-0010: The budget guard — what `pd` can actually guard, and what it refuses to pretend

Status: accepted
Date: 2026-08-12
Deciding ticket: [Budget guard: pre-flight estimation, reactive accounting, or both](../../.scratch/pd-cli-design/issues/16-grilling-budget-guard.md)
Amends [ADR-0005](0005-cache-design.md) §7: `pd cache clear` no longer deletes the whole cache subtree

## Context

The Pipedrive daily token budget is shared across the whole company account, and the map carries "an
agent must not be the tool that drains it" as a safety property alongside read-only. This ADR decides
what mechanism actually delivers that property.

The ticket was written on three assumptions, and research killed two of them outright:

- **Reactive accounting is impossible.** No documented response header reports the remaining daily
  token budget. All four documented headers are burst-window headers or a POST/PUT-only request
  counter. See [rate limiting research](../../.scratch/pd-cli-design/research/01-rate-limits-and-token-budget.md).
- **Pre-flight estimation of a walk is impossible.** v2 reports no total count anywhere, so a walk's
  size cannot be known before walking it. See
  [cursor pagination research](../../.scratch/pd-cli-design/research/02-cursor-pagination-semantics.md).
- **The denominator is unknowable too.** The budget is `30,000 base tokens × plan multiplier × seats`,
  and no documented endpoint reports the plan tier or the seat count. Nor can `pd` see spend by
  colleagues' integrations against the same pool.

What survives is predictive self-accounting from the `x-token-cost` table — `pd` can know what `pd`
spent, and nothing else.

## Decision

### 1. There is no remaining-budget floor, because there is no floor to read

The ticket asked whether `pd` should refuse to run below some remaining-budget floor. It cannot. `pd`
can see neither the pool's size, nor its balance, nor other consumers of it. A floor would be a number
computed from nothing.

The only mechanism the documentation supports is a different thing wearing the same name: a
per-credential ceiling on `pd`'s **own** daily spend. That is decided next, and rejected.

### 2. There is no daily token ceiling at all

`pd` does not track token spend across invocations, does not persist a token ledger, and does not
refuse to run on the grounds of accumulated daily cost. No default ceiling, no opt-in flag.

The arithmetic is the argument. At v2 costs, a full 40,000-record walk at the maximum page size of 500
costs 80 requests × 10 tokens = **800 tokens**. A cold `--resolve` adds at most four metadata requests
(≈40 tokens) plus at most `--resolve-budget` relation batches (≤500 tokens). So the heaviest single
run `pd` can currently produce costs roughly **1,300 tokens**, against a smallest-possible pool of
30,000. A single run is structurally incapable of being the problem.

That leaves the runaway agent loop, and a ceiling aimed at it would have to be an arbitrary absolute
number: the same value is a third of a Lite single-seat pool and a fraction of a percent of an
Ultimate pool. It would interrupt legitimate work against a hazard that has not been observed in
practice on this account.

**Stated as an assumption rather than a fact, because it is the deciding input:** the account this
tool is built for has never reached the daily token budget. If that changes, adding a ceiling is a new
decision, and it should be anchored on measurement rather than on a guess.

The consequence, accepted and recorded plainly: **`pd` does not guard the shared daily budget.** It
reduces pressure on it — v2 over v1 halves cost, `limit=500` cuts a walk's request count fivefold, and
[ADR-0005](0005-cache-design.md)'s cache removes repeat metadata fetches — but nothing in `pd` will
stop an agent that runs it ten thousand times.

This also disposes of the ticket's cross-invocation ledger question, and of the reset problem behind
it: the daily budget resets "at midnight at server's timezone" and the server timezone is named
nowhere, so a ledger could not have expired honestly anyway. Fabricating a midnight is the same lie
[ADR-0001](0001-error-model-and-exit-codes.md) refused when it chose `not_today` over a fake countdown.

### 3. `--max-requests` is the only quantitative guard, and it has no default

`--max-requests <n>` stays exactly what the locked contract says: a hard ceiling that aborts before it
is exceeded, exit 3, `code: "request_ceiling"`, `complete: false`.

It counts **network requests**, not tokens and not cache hits, per [ADR-0005](0005-cache-design.md) §4.
A request count is admittedly not a token cost — but with no daily ceiling there is no second guard for
it to disagree with, so one guard in one denomination is the whole story. The flag protects a run from
being larger than the caller expected; it is not a budget instrument.

**There is no default value.** Absent the flag, a run is unbounded in requests. A default ceiling would
contradict the locked pagination property: "all deals" must mean all of them, and a silent request
ceiling would make `complete: false` the normal outcome of an ordinary command.

### 4. Enrichment yields to the guard; it never trips it

[ADR-0008](0008-resolution-mechanics.md) §10 drew this boundary for relation resolution. It generalises
here to a rule over every request `pd` makes that the caller did not directly ask for — relation
batches, field schemas, `users`, `pipelines`, `stages`:

> An enrichment request is issued only if the remaining `--max-requests` headroom would survive it.
> Otherwise the enrichment stops, degrades to raw ids with one `warning` line and `resolved: "partial"`
> on the trailer, and the run continues to exit 0.

So `request_ceiling` can only ever be caused by the pagination walk the caller asked for. An agent that
hits the ceiling learns something true about its own query rather than about a decoration on it.

### 5. A run stopped by the guard is not resumable, and the two ADRs agree

[ADR-0003](0003-pagination-bounding-and-partiality.md) established that there is no resumption token,
because a cursor of undocumented stability cannot promise one. The ticket asked this ADR to confirm the
guard's stop report agrees with the partiality marker, and it does: `--max-requests` produces an `error`
trailer carrying `code: "request_ceiling"`, `complete: false`, and the `emitted` / `skipped` /
`duplicates` bookkeeping, exit 3. The caller raises the ceiling and runs the command again.

A resumption is therefore never cheaper than a restart, because it does not exist.

### 6. One piece of cross-invocation state survives: the `blocked` sentinel

This is a Cloudflare question, not a budget question. Research 01 found that continuing to send traffic
after a 429 earns a 403 whose body is an HTML error page and which blocks **the whole company's**
`api_token` traffic. [ADR-0001](0001-error-model-and-exit-codes.md) gave that its own `blocked` variant
precisely because its blast radius is the account rather than the run, and forbids retrying it inside a
process.

The gap that leaves is between processes. An agent looping `pd` fifty times gets fifty fresh retry caps,
none aware that the previous invocation already met a company-wide block.

**On a `blocked` outcome, `pd` writes a sentinel** under the credential's directory,
`~/.cache/pd/<token-hash>/`. While that sentinel is live, every subsequent invocation for the same
credential refuses immediately: **zero HTTP requests**, `code: "blocked"`, exit 3.

- **It reuses `code: "blocked"`.** ADR-0001's rule is that a variant exists only when the caller must
  respond differently, and the correct response is identical — stop, tell a human. `details` records
  that the block came from memory rather than from a fresh response; per ADR-0001 nothing in `details`
  may be branched on.
- **It expires after 15 minutes**, then the next run tries once for real. A fixed cool-off is used
  rather than "until the daily reset" for the reason in §2: the reset instant is unknowable.
- **`budget_exhausted` gets no sentinel.** A 429 costs one rejected response and does not escalate, so
  remembering it buys nothing and would suppress the run that would have discovered the budget had
  reset.

Keeping this to a single remembered variant is deliberate. It is the one state whose absence makes
things actively worse for people other than the caller.

### 7. The sentinel cannot be overridden, and `pd cache clear` no longer removes it

There is no `--ignore-block` flag and no equivalent. A flag an agent can set is not a barrier; it is a
speed bump that `--help` advertises to the very consumer it is meant to stop. The whole point of the
tool is that an agent cannot cause damage, and a documented escape hatch from the one company-wide
safety stop contradicts that directly.

The same argument applies indirectly to `pd cache clear`, which [ADR-0005](0005-cache-design.md) §7
defined as deleting the `~/.cache/pd/` subtree with no arguments and no flags. An agent that meets an
error and tries "clear the cache and retry" — an entirely ordinary recovery reflex — would delete the
sentinel and walk straight back into the block. **`pd cache clear` therefore preserves the sentinel**;
its target is the subtree minus that file. `pd cache info` reports the sentinel's presence and age,
because a human debugging a refusal that made no requests has no other way to see it.

**`--no-cache` does not bypass the sentinel either.** The flag is defined over cached *data* — it
skips a stale read and fetches fresh. The sentinel is guard state that merely happens to share a
directory with the cache, and "retry with `--no-cache`" is exactly as ordinary an agent recovery
reflex as "clear the cache and retry". The rule is one line: nothing in the cache surface, read or
write, reaches the sentinel.

The sentinel is removed by exactly two things: the 15-minute expiry, and a human deleting the file.

The accepted cost is that a false positive costs a 15-minute wait or manual work. That is the right
direction to be wrong in: a false negative costs the whole company its API access.

### 8. The internal retry cap stays process-scoped

Ticket 09 left the process-scoped retry cap on this ticket's doorstep, to be decided together with the
budget state. With no budget ledger to host it, it stays where it is.

This is safe because ADR-0001 already forbids retrying the two situations that escalate — a 429 inferred
as budget or not inferable at all, and a Cloudflare 403 — so a fresh process cannot resume a retry storm.
What a fresh process does get is one fresh burst-retry allowance, and a burst window is two seconds
wide; a new invocation is always at least that far from the previous one's last request in any realistic
loop. The concrete counts and delays remain the concurrency ticket's to set.

## Consequences

- **`pd` makes no promise about the shared daily budget.** `AGENTS.md` must say so plainly rather than
  implying a guard exists. The honest statement is that `pd` minimises cost per unit of work and stops
  hard on a company-wide block, and that budget stewardship remains a human's job through Pipedrive's
  own API Usage Dashboard.
- **ADR-0005 §7 is amended.** `clear`'s target is no longer a constant subtree; it is that subtree with
  one file preserved. The property that mattered there — no path argument, no pattern, no widening flag
  — is untouched.
- The `blocked` sentinel is a new on-disk artefact and inherits ADR-0005 §6's mechanics: `0600`, written
  via temporary file plus `rename`, carrying a schema version, and holding no credential. An
  unrecognised or unparseable sentinel is treated as absent, which fails open — accepted, because the
  alternative is a tool bricked by a corrupt file.
- `--max-requests` having no default means a runaway query is bounded only by the data. ADR-0003's
  stderr warning every 10,000 emitted records remains the only signal that a walk is large.
- The ticket's question of whether the token guard should adopt ADR-0008 §10's yielding behaviour is
  answered by there being no token guard; §4 above instead promotes the yielding rule to cover every
  enrichment request against the one guard that exists.
- If the account ever does exhaust the daily budget, this ADR is the thing to revisit, and §2's stated
  assumption is where the argument restarts.
