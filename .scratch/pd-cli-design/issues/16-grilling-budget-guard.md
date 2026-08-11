# Budget guard: pre-flight estimation, reactive accounting, or both

Type: grilling
Status: open

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
