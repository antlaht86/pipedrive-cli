# The narrow v1 client for `users`

Type: grilling
Status: open

Blocked by: 04, 06

## Question

**Rescoped while resolving ticket 13.** The v1 API is out of scope except for the `users` resource;
leads, notes, currencies, activity types and filters are not exposed by `pd`. See
[ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md) and the map's Out-of-scope
section. The open question is no longer *which* v1 resources reach the command surface, only how the
one that does is built.

`users` exists solely so `owner_id` resolves to a person's name. [ADR-0005](../../../docs/adr/0005-cache-design.md)
already reserved it a cache entry with a 1 hour TTL and noted it stays inert until this ticket ships.

- A second generated client restricted to the v1 `users` endpoints, versus a hand-written wrapper for
  the one or two calls needed. Locked point 2 forbids hand-writing a client, so a wrapper would have
  to be argued as something else — or dropped. Research 06 verified that two jobs in one
  `openapi-ts.config.ts` coexist without collisions, and that `filters.operations.include` can narrow
  the output to a chosen set of operations.
- How the second client is forced through the same `guardedFetch`, given that rate limit state, the
  `p-limit` limiter and the budget counter are per account rather than per client. Research 06 flags
  that v1 costs double — a list is 20 tokens against v2's 10.
- Whether `users` is ever exposed as a command of its own (`pd users list`), or exists only as an
  internal lookup behind owner-name resolution. If it is a command, its pagination and error shapes
  are v1 shapes and must not leak a version distinction the caller has to know about.
- What `pd` does when the v1 `users` fetch fails or is unavailable. ADR-0005 assumed the degradation
  is "no owner names"; this ticket confirms or replaces it, and decides whether that degradation is
  silent, a `warning`, or an error.
- Research 06 never ran the v1 generation job. Whether the v1 spec needs its own `parser.patch`
  corrections under ADR-0006's rules is unknown and must be established here.
- What happens when `users` gains a v2 endpoint and this whole client can be deleted.

Record as an ADR.
