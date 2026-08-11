# The narrow v1 client for `users`

Type: grilling
Status: resolved

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

## Answer

Recorded as [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md).

The v1 footprint is **one generated operation**. A second `openapi-ts` job outputs to
`src/lib/pipedrive/v1/generated`, filtered to `GET /users` alone; the wrapper constructs both clients
and hands both the same `guardedFetch`, since rate state, the limiter and the budget counter are
per account. A v1 list costs 20 tokens against v2's 10.

**The generation job was run for this ticket** — research 06 open question 8 is now closed. Five
files, 790 ms, exit 0, no `parser.patch` required. The generated envelope confirms `GET /users` has
no `additional_data` at all, matching research 04's finding that it is unpaginated: no v1 pagination
helper, neither v1 envelope shape, nothing for ADR-0003 or ADR-0004 to bound.

**No v1 spec patch is needed, because nothing trusts the spec.** `pd` defines the user record schema
itself under ADR-0006's rules: `id` and `name` required, everything else optional, unknown keys
stripped. That is also what makes the eventual v2 migration invisible — the emitted `record` shape is
`pd`'s, not Pipedrive's.

`users` is exposed as **both** commands. `pd users list` emits ordinary `record` lines and one
`summary`; `pd users get <id>` filters the cached list rather than calling `/users/{id}`, so it costs
zero requests on a warm cache, and an unknown id triggers ADR-0005's one-shot refresh before
returning `not_found`. Deactivated and deleted users are included — `owner_id` on an old deal often
points at someone who has left. No output field names a version, an offset or `success`.

Resolution is one flag, `--resolve`, covering custom field hashes, option labels and owner ids
together; this **retires the name `--resolve-fields`** used in ADR-0005. It is additive —
`owner_name` beside `owner_id`, `creator_user_name` beside `creator_user_id`, `user_name` beside
`user_id`, a closed list — and an unresolvable id omits the sibling rather than emitting a null.

A failed user fetch under `--resolve` degrades: one `warning` of kind `owner_resolution_unavailable`
per run, raw ids, exit 0. For `pd users list` and `pd users get` the same failure is a hard error,
because there the user list is the answer rather than an enrichment.
