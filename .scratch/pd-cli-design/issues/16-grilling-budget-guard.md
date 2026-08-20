# Budget guard: pre-flight estimation, reactive accounting, or both

Type: grilling
Status: resolved

Blocked by: 01, 11, 14

## Question

The daily budget is shared with the whole company. How does `pd` refuse to be the tool that drains it?

- Pre-flight estimation: can the cost of a command be estimated before the first request, given ticket 02 found whether a total count is cheaply available? What does the tool do with an estimate — refuse, warn on stderr, or nothing?
- Reactive accounting from the response headers ticket 01 identified: track remaining budget as the run proceeds and stop at a threshold. What threshold, and is it absolute or a fraction of the pool?
- Whether both are needed, and what each catches that the other does not.
- The relationship between `--max-requests` and the budget. `--max-requests` is locked as a hard ceiling that aborts before it is exceeded, but a request count is not a token cost. Are they two separate guards, and does a token-cost ceiling also exist?
- Whether `pd` should refuse to run at all below some remaining-budget floor, so a looping agent cannot take the last of a pool a colleague's integration needs. This is the safety property, so argue it as one.
- How a run stopped by the guard reports itself so the agent can resume rather than restart — which is ticket 11's partiality marker, so confirm the two agree and that a resumption is actually cheaper than a restart.
- Whether budget state persists between invocations. An agent invoking `pd` fifty times in a loop passes fifty independent guards unless something remembers. Where does that state live, and what happens when two `pd` processes run at once?
- Whether the guard can be overridden, and whether an override belongs in a tool whose whole point is that an agent cannot cause damage.

Record as an ADR.

## Context added while resolving other tickets

- [Pipedrive rate limiting and the shared daily token budget](01-research-rate-limits-and-token-budget.md) removed this ticket's reactive option: **no header reports the remaining daily budget**. Accounting must be predictive, from the flat per-operation `x-token-cost` table. And [Cursor pagination semantics](02-research-cursor-pagination-semantics.md) removed the pre-flight option for walks: **v2 has no total count anywhere**, so a walk's size cannot be estimated before walking it.
- [The error union, exit codes, and machine-readable failure](09-grilling-error-union-and-exit-codes.md) left a problem on this ticket's doorstep: the **internal retry cap is process-scoped**, exactly like the budget accounting. An agent invoking `pd` fifty times in a loop passes fifty independent guards and fifty fresh retry caps, none aware of the others. Whatever cross-invocation state answers the budget question must answer the retry question too — decide them together.


- [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) leaves two request-denominated knobs for
  this ticket to reconcile. `--max-requests` stays the guard locked point 4 describes: a hard ceiling
  that aborts, exit 3, `complete: false`. `--resolve-budget <n>` is **not** a guard — it bounds an
  enrichment, defaults to 50, and reaching it degrades to raw ids with one `warning` and
  `resolved: "partial"`, exit 0. The boundary ADR-0008 §10 draws is that resolution *yields* to the
  guard rather than consuming it: relation resolution stops issuing requests once the remaining
  `--max-requests` headroom would not survive a batch, so an enrichment can never be the thing that
  trips the ceiling. This ticket owns whether the predictive token guard behaves the same way.
- The fixed-cost half of `--resolve` — one field schema, `users`, `pipelines`, `stages` — is at most
  four requests on a cold cache and zero on a warm one, per ADR-0008. ADR-0005 §4's parenthetical
  "at most six metadata requests" predates that arithmetic and should not be relied on.

## Answer

Full detail in [ADR-0010](../../../docs/adr/0010-budget-guard.md).

`pd` does not guard the shared daily budget, and says so rather than pretending. Research removed
every input a budget guard would need: no header reports the remaining pool, v2 reports no total
count so a walk cannot be estimated before it is walked, and neither the plan tier nor the seat count
is readable, so even the denominator is unknown — and spend by colleagues' integrations is invisible
by construction. What remains possible is predictive self-accounting, which was considered and
rejected: at v2 costs the heaviest single run `pd` can produce is roughly 1,300 tokens against a
smallest-possible pool of 30,000, so no single run is the hazard, and a ceiling aimed at the runaway
loop would be an arbitrary absolute number interrupting legitimate work. The deciding input is stated
in the ADR as an assumption rather than a fact: the account a run points at does not reach its daily
budget.

That disposes of the cross-invocation token ledger and, with it, the reset problem — the budget resets
"at midnight at server's timezone" and the server timezone is named nowhere, so no ledger could have
expired honestly.

`--max-requests` is therefore the only quantitative guard, counted in network requests, with **no
default value** — a default would make `complete: false` the ordinary outcome and contradict the
locked complete-pagination property. ADR-0008 §10's yielding rule is promoted to cover every
enrichment request, so `request_ceiling` can only ever be caused by the walk the caller asked for.
The ticket's resumption question is confirmed against ADR-0003: there is no resumption, so a restart
is the only path and the two ADRs agree.

One piece of cross-invocation state survives, and it is a Cloudflare question rather than a budget
one: a `blocked` outcome writes a **sentinel** under `~/.cache/pd/<token-hash>/`, and while it is live
every invocation for that credential refuses with zero HTTP requests, `code: "blocked"`, exit 3. It
reuses the existing variant because the caller's correct response is identical, expires after 15
minutes rather than at an unknowable midnight, and covers only `blocked` — a `budget_exhausted` 429
costs one rejected response and does not escalate. It has no override flag, and **`pd cache clear`
now preserves it** and `--no-cache` does not bypass it, because an agent's ordinary "clear the cache
and retry" reflex would otherwise delete the one company-wide safety stop. This amends ADR-0005 §7.

Ticket 09's debt is settled by this: the internal retry cap stays process-scoped, which is safe
because ADR-0001 already forbids retrying the two situations that escalate.
