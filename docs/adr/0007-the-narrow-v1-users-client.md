# ADR-0007: The narrow v1 `users` client, and owner-name resolution

Status: accepted
Date: 2026-08-11
Supersedes in part: the flag name `--resolve-fields` used in ADR-0005
Extended by [ADR-0008](0008-resolution-mechanics.md): the closed table of §7 grows from three sibling fields to seven

## Context

Research 04 found the v1 API splits into three classes, and the map ruled all of Class B out of scope
except one resource: `users`. It survives alone because `owner_id` is otherwise an unresolvable
number on every deal, person, organization and product `pd` emits, and because ADR-0005 already
reserved it a cache entry with a 1 hour TTL that stays inert until this ADR ships.

Two facts narrow the problem more than the ticket assumed.

**`GET /users` (v1) is unpaginated.** Research 04 confirmed it declares zero parameters and returns
the full collection in one response. There is no `start`, no `next_start`, no `more_items_in_collection`,
and therefore none of the v1 envelope trap that research 04 warned about — the two incompatible v1
pagination shapes never arise, and ADR-0003's bounding and ADR-0004's page machinery have nothing
to bound.

**The v1 generation job was run for this ADR** and is no longer an unknown. Research 06 open
question 8 recorded that it had never been executed. It was executed against
`https://developers.pipedrive.com/docs/api/v1/openapi.yaml` with the recommended configuration from
research 06 §7, filtered to `GET /users*`: five files, 790 ms, exit 0, no error. The generated
envelope is `z.object({success}).and(z.object({data: z.array(...)}))` — confirming the absence of
`additional_data` from the spec side too. No Pipedrive API call was made; generation reads the
published spec only, so this cost nothing from the shared daily budget.

## Decision

### 1. A second generated job, narrowed to one operation

The v1 client is generated, not hand-written — locked point 2 admits no exception, and the "argue a
hand-written wrapper as something else" branch in the ticket is closed rather than taken.

`openapi-ts.config.ts` exports an array of two jobs, per research 06 §6: the v2 job to
`src/lib/pipedrive/v2/generated`, the v1 job to `src/lib/pipedrive/v1/generated`. Separate output
directories mean separate module namespaces, so `getUsers` existing in both specs never collides.
The merge form (`input: [a, b]`) is not used.

The v1 job's filter is `operations: { include: ['/^GET \\/users$/'] }` — the collection endpoint and
nothing else. The exploratory filter `/^GET \/users/` used while establishing generability pulled in
eight operations: `getUsers`, `getUser`, `getCurrentUser`, `findUsersByName`, `getUserFollowers`,
`getUserPermissions`, `getUserRoleAssignments`, `getUserRoleSettings`. Seven of those are surface
`pd` never calls, and generated code that exists is generated code someone can call. One operation
is the whole v1 footprint.

The anchored filter was run rather than assumed: it emits exactly one export, `getUsers`, in 808 ms.

`GET /users/{id}` is deliberately excluded — see section 4.

### 2. Both clients are created by the one wrapper module and share one gate

Locked point 7 says every HTTP call goes through one client module. A second generated client does
not weaken that, because `sdk.client: false` (research 06 §2) leaves no ambient client anywhere: a
generated function cannot be called without being handed a client instance, and the only code that
constructs one is the wrapper.

The two clients differ only in `baseUrl` (`/api/v1` against `/api/v2`) and are given the same
`guardedFetch`. Rate limit state, the `p-limit` limiter and the budget counter are properties of the
**account**, not of the client, so they live in the gate module and are shared. A v1 request queues
behind v2 requests in the same limiter and decrements the same counter.

The cost table entry differs: a v1 list is 20 tokens against v2's 10. That is charged to the same
budget, and the arithmetic ADR-0005 §1 already recorded — roughly 480 tokens a day per active
machine at a 1 hour TTL — stands.

### 3. `pd` owns the user record schema, not Pipedrive

The generated zod schema for `GET /users` marks all twenty fields required, because
`propertiesRequiredByDefault: true` is set; only `phone`, `modified` and `icon_url` are nullable in
the spec itself. That is a claim about a real CRM that nobody has verified, and a deactivated
colleague who never logged in is a plausible counterexample for `last_login`.

Rather than guessing at a `parser.patch` for the v1 spec, `pd` defines its own record schema at the
wrapper boundary, as ADR-0006 already requires for every resource:

- `id` and `name` are required. Without them the record cannot do the one job it exists for.
- Every other field is optional. `email`, `active_flag`, `is_deleted` and `timezone_name` are kept
  because they are the fields a human asks about a user; the rest are stripped by ADR-0006's
  unknown-key rule.

The envelope schema is `{ success, data: unknown[] }` with no `additional_data` member. It is
validated strictly and a failure ends the fetch as `invalid_response`, exactly as ADR-0006 §1
specifies. Records are validated individually.

**Consequence: the v1 spec needs no `parser.patch` corrections.** Not because the spec is right, but
because nothing downstream of generation trusts it. The generated types are used for call shapes;
the schema that decides whether a response is acceptable is hand-written. This answers the ticket's
open question, and it is the same answer ADR-0006 gave for v2 — the difference is only that the v1
spec's lower quality (no `components.schemas`, per-operation inline types) makes it more obviously
correct here.

### 4. `pd users get <id>` is served from the cached list and issues no request of its own

`users` is a collection of tens, fetched whole in one response, and ADR-0005 already caches it for
an hour. Fetching `/users/{id}` would spend a second request to learn a subset of what the first one
returned.

So `get` filters the list. On a warm cache it costs zero requests; on a cold one it costs the same
single 20-token fetch `list` costs, and the cache is then warm for both.

An id absent from the list triggers ADR-0005 §3's unrecognised-key refresh — one re-fetch regardless
of TTL — and if the id is still absent, the run ends as `not_found` per ADR-0001. A deleted user is
therefore distinguishable from a stale cache without the caller doing anything.

### 5. Both commands emit `pd`'s NDJSON contract, and no v1-ness reaches stdout

`pd users list` and `pd users get <id>` emit `record` lines and exactly one `summary` trailer, per
ADR-0002. Nothing in the output names a version, an offset, a `start` or a `success` field.

- `complete` is `true` unless `--limit` truncated the list, in which case it is `false` with
  `reason: "limit"` — ADR-0003 applies unchanged, even though the underlying fetch is a single
  response.
- `requests` is `0` on a cache hit, per ADR-0005 §4.
- `emitted`, `skipped` and `duplicates` behave as ADR-0003 defines them. `duplicates` is structurally
  always `0` here, and is still present, because a trailer field that appears conditionally is worse
  than one that is always zero.

**Deactivated and deleted users are included.** `owner_id` on a two-year-old deal frequently points
at a colleague who has left, and a resolver that cannot name them fails at exactly the moment the
name is most needed. `active_flag` and `is_deleted` are retained on the record so a caller can filter
if it cares.

### 6. One `--resolve` flag turns on every id-to-name resolution

The flag is `--resolve`. It resolves custom field hashes, enum and set option labels, **and** owner
ids, in one switch.

This renames the `--resolve-fields` flag, which ADR-0005 refers to by name in five places; those
references should be read as `--resolve`. Ticket 15 still owns what `--resolve` does to custom
fields; this ADR fixes only the flag's name and its owner-id half.

The accepted cost is that a caller wanting only owner names also pays for field schemas. It is
bounded: at most four schema requests, each cached 24 hours, each 10 tokens. The alternative — a
second `--resolve-owners` flag — makes the common case (`--resolve-fields --resolve-owners`) two
flags long and asks an agent to know which kind of unreadable id it is looking at before it can ask
for readability. One flag means "make this output legible to me", which is the only intent an agent
actually has.

### 7. Resolution is additive: `owner_name` alongside `owner_id`

`--resolve` adds a sibling field and never replaces or removes the id. Locked point 6 requires raw
values to stay so output is stable and diffable, and an agent that reads `owner_name` in one command
must still be able to pass `owner_id` to the next one.

The set of fields resolved is closed, and is closed for the same reason ADR-0005's cache list is:
a surface small enough to state in full is a surface that can be reasoned about.

| Raw field | Added |
| --- | --- |
| `owner_id` | `owner_name` |
| `creator_user_id` | `creator_user_name` |
| `user_id` | `user_name` |

An id present on a record but absent from the user list resolves to nothing: the sibling field is
omitted rather than set to `null` or to the id as a string. A missing key is unambiguous; a name that
is secretly a number is not.

### 8. A failed user fetch degrades to raw ids with one `warning`

When `--resolve` is requested and the `users` fetch fails — v1 unreachable, a 403, a structural zod
rejection, anything — the run emits one `warning` line, drops owner resolution for the whole run,
and continues emitting records with raw ids. It exits 0.

```json
{"type":"warning","kind":"owner_resolution_unavailable","resource":"users","message":"Could not fetch the user list; owner ids are unresolved."}
```

`kind` fits ADR-0006 §6's discriminator. The line is emitted **once per run**, not once per record:
ADR-0006's deduplication by cause already forbids 40,000 identical warnings, and here the cause is a
single event rather than a per-record property.

This follows ADR-0005 §5's precedent — a cache entry that cannot be read degrades and says so rather
than failing the run. Killing a 40,000-record walk that was otherwise perfect, and burning the budget
it spent, over an ancillary 20-token lookup, is the worse trade. Silence was rejected by ADR-0005 §5's
own argument: a permanently broken path with no signal anywhere drains the shared budget forever.

**The asymmetry is deliberate.** A failed fetch degrades under `--resolve`, but it is a hard error
for `pd users list` and `pd users get`, which fail per ADR-0001 with whatever variant the failure
maps to. There, the user list is not an enrichment — it is the answer.

### 9. Deleting this client when `users` reaches v2

The migration is: remove the v1 job from `openapi-ts.config.ts`, delete `src/lib/pipedrive/v1/`,
point the resolver at the v2 operation, drop the second `baseUrl` from the wrapper.

Nothing else changes, and that is a consequence of section 3 rather than luck. Because `pd` defines
the user record schema itself, the `record` lines emitted by `pd users list` do not change shape when
the upstream envelope does; because ADR-0005 keys the cache by credential and version-stamps every
entry, the old entry is discarded as unrecognised rather than misread. The only observable difference
is that the fetch costs 10 tokens instead of 20.

Until then, the v1 spec URL is a live dependency of the build, not of the runtime. A regeneration
months from now can fail if Pipedrive withdraws the v1 spec; the committed generated output means
that breaks a regeneration, never a released `pd`.

## Consequences

- The v1 footprint of `pd` is one operation, one output directory and one `baseUrl` — small enough
  to delete in an afternoon.
- `--resolve` is the single legibility flag. ADR-0005 mentions `--resolve-fields`; that name is
  retired. `AGENTS.md`, the manifest and every `--help` must use `--resolve`.
- Ticket 15 inherits two constraints: resolution is additive and preserves raw values, and its
  request cost is now the field schemas *plus* one 20-token user fetch on a cold cache.
- ADR-0005's `users` cache entry stops being inert. Its 1 hour TTL and its unknown-`owner_id` refresh
  rule are both now load-bearing.
- `pd users list` can report `requests: 0`, which is the first command where the whole answer may come
  from disk. ADR-0005 §4 already permits it; documentation must not promise a request per command.
- A caller cannot ask `pd` for a user's permissions, roles, followers or the identity behind the
  current token. Those are seven excluded operations, and re-admitting any of them is a new decision.
