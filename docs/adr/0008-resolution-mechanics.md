# ADR-0008: What `--resolve` resolves, where it puts the answer, and what it costs

Status: accepted
Date: 2026-08-11
Extends: [ADR-0007](0007-the-narrow-v1-users-client.md) §6 and §7 — the flag and the additive rule
Supersedes in part: [ADR-0005](0005-cache-design.md) §1 — the closed cache list grows from five entries to eight

## Context

ADR-0007 named the flag `--resolve`, made it one switch for every id-to-name lookup, and fixed
resolution as **additive**: a sibling field beside the raw value, never a replacement. It settled the
owner-id half and left the custom-field half to this ADR.

Three facts were established from the v2 OpenAPI spec while deciding this, rather than assumed.

**Every field schema `pd` needs is in v2 and costs 10 tokens.** `/activityFields`, `/dealFields`,
`/personFields`, `/organizationFields`, `/productFields` and `/projectFields` all exist in
`openapi-v2.yaml` with `x-token-cost: 10`. Research 03's "some field schemas are v1-only" applied to
`leadFields` and `noteFields`, and leads and notes left the scope with ADR-0006. There is no v1
schema left to worry about.

**Batch fetching by id exists.** `GET /deals`, `/persons`, `/organizations`, `/activities` and
`/products` all accept an `ids` query parameter: *"Optional comma separated string array of up to 100
entity ids to fetch… If any of the requested entities do not exist or are not visible, they are not
included in the response."* Resolving 3,000 distinct organizations therefore costs about 30 requests,
not 3,000. This single fact is what makes relation resolution affordable at all.

**Reference fields on a v2 record are bare integers.** A deal carries `person_id`, `org_id`,
`pipeline_id` and `stage_id` as plain numbers with no accompanying name — the same illegibility
ADR-0007 fixed for `owner_id`, on four more fields. `/pipelines` and `/stages` cost 5 tokens each and
return collections of tens.

**`include_option_labels` is a trap, not a shortcut.** The spec says it makes option values *"contain
objects in the form of `{ id: number, label: string }` **instead of** plain id"*. It rewrites the raw
value rather than adding to it, and it exists only on `/deals`, `/deals/archived`, `/persons` and
`/organizations` — not on activities or products.

## Decision

### 1. Resolved custom fields live in a parallel `custom_fields_resolved` block, keyed by hash

`custom_fields` is emitted byte-for-byte the same whether `--resolve` is passed or not. Resolution
adds one sibling object at the top level of the record:

```json
{"type":"record","id":42,"title":"Acme renewal",
 "custom_fields":{"9a3f…c1":3,"7b12…e0":"2026-09-01"},
 "custom_fields_resolved":{
   "9a3f…c1":{"name":"Contract type","label":"Annual"},
   "7b12…e0":{"name":"Renewal date"}}}
```

This follows ADR-0007 §7 rather than deviating from it: raw values survive untouched, so locked point
6's diffability holds and an agent that reads a label can still pass the raw value to the next
command.

Enriching in place — turning `custom_fields["9a3f…c1"]` into `{value, name, label}` — was rejected
because it makes one JSON path hold a number under one invocation and an object under another. A
consumer would have to branch on a flag it did not set.

**Keying the block by hash rather than by display name dissolves the duplicate-name problem
entirely.** Two custom fields on the same entity may share a display name, and Pipedrive does nothing
to disambiguate them (research 03). Keyed by name, that is a duplicate JSON key and the output stops
being parseable; keyed by hash, the collision cannot occur, because a hash is unique by construction.
No suffixing rule, no qualification scheme, no refusal-to-resolve case. The ticket's disambiguation
question is answered by not creating it.

The cost is that reading a name costs one more hop than a name-keyed block would. That is a fair
trade for an output shape that cannot be made invalid by the CRM's configuration.

### 2. `--resolve` resolves everything resolvable, not only enum options

The set is closed and stated in full:

| Field type | `label` becomes | Source |
| --- | --- | --- |
| `enum`, `set` | option label, or an array of them | cached field schema |
| `user` | the person's name | cached `users` list (v1, ADR-0007) |
| `person`, `organization` (relation) | the entity's name | batched `ids` fetch |
| `monetary` | `"12000.00 EUR"` | the raw value itself |
| `address` | comma-joined subfields | the raw value itself |
| `date`, `varchar`, `text`, `double` | omitted — no `label` | — |

A field whose raw value is already legible gets a `name` and no `label`. Emitting a `label` identical
to the raw value would be noise the consumer must still compare to be sure.

The narrower alternative — enum and set only — was rejected as internally inconsistent: the same
colleague would appear as `owner_name` on one part of the record and as the integer `12` inside
`custom_fields` on another.

### 3. Standard reference fields resolve too, and ADR-0007 §7's table grows to seven

| Raw field | Added |
| --- | --- |
| `owner_id` | `owner_name` |
| `creator_user_id` | `creator_user_name` |
| `user_id` | `user_name` |
| `person_id` | `person_name` |
| `org_id` | `org_name` |
| `pipeline_id` | `pipeline_name` |
| `stage_id` | `stage_name` |

The rule from ADR-0007 §7 carries over unchanged: **an id that cannot be resolved omits its sibling
key entirely**. Not `null`, not the id rendered as a string. A missing key is unambiguous; a name that
is secretly a number is not. The same rule governs `custom_fields_resolved` — an unresolvable hash is
simply absent from the block.

Not extending to these fields was rejected on the same consistency argument as section 2: a custom
field of type `organization` would resolve to a name while the record's own `org_id` stayed a number.

### 4. Values are formatted neutrally, never for a locale

`label` is a machine-first string. No thousands separators, no locale decimal mark, no timezone
conversion, no currency symbol substitution.

```
monetary  "12000.00 EUR"
address   "Mannerheimintie 1, 00100 Helsinki, Finland"
```

Locale-aware formatting was rejected because it makes the same record produce different bytes on
different machines — the developer's laptop and CI disagree over `12 000,00 €` against `12,000.00 EUR`
— which breaks locked point 6's diffability silently rather than loudly. It is also lossy in one
direction only: an agent given `12000.00 EUR` can format it for a human, while an agent given
`12 000,00 €` cannot reliably parse it back.

**This settles formatting for resolved values only.** How raw `value` and `currency` are represented
without `--resolve` is still the map's open *Value formatting* question.

### 5. `include_option_labels` is not used; option labels are resolved client-side

The parameter replaces the plain id rather than adding to it, so passing it would change `custom_fields`
depending on whether `--resolve` was set — exactly what section 1 forbids. Its coverage is partial:
deals, archived deals, persons and organizations, but not activities or products, so relying on it
would mean two resolution mechanisms with different behaviour on different entities.

Against that it buys nothing. The field schema is fetched regardless, because it is the only source
of the field *names* in section 1, and the schema that carries the names carries the option labels
in the same response. Client-side resolution is therefore free and uniform.

### 6. The cache grows to eight entries; every v2 field schema is cached for 24 hours

ADR-0005 §1 declared a closed list of five. It becomes eight:

| Entry | TTL |
| --- | --- |
| `users` | 1 h |
| `dealFields`, `personFields`, `organizationFields`, `productFields`, `activityFields` | 24 h |
| `pipelines`, `stages` | 24 h |

`activityFields` was excluded by ADR-0005 in the company of `leadFields` and `noteFields`, on the
belief that those three shared a property. They did not — the other two are v1-only and now out of
scope, while `activityFields` is v2 and costs the same 10 tokens as the four that were cached. The
exception had no surviving justification, and the rule that replaces it is shorter to state than the
list it replaces: **every v2 `*Fields` schema is cached for 24 hours.**

`pipelines` and `stages` join on the same reasoning as the schemas: they change when an administrator
edits the pipeline configuration, not when a deal moves.

This does not widen the surface ADR-0005 §1 was protecting. The list is still closed, still holds no
entity records and no result sets, and is still short enough to state in full. **Records fetched to
resolve a relation are not cached** — they are held in memory for the run and discarded, because
ADR-0005's freshness argument against caching records applies whether the record is emitted or merely
consulted.

`projectFields` exists in v2 and is deliberately not listed. Projects have no command surface yet;
when ticket 19 decides whether they get one, the 24-hour rule admits it without a new decision.

### 7. Relation ids are batched per page, never collected across the run

Resolution runs page by page. For each page, the unique unresolved ids are collected per entity type
and fetched in batches of 100 via `ids`; the page is then emitted fully resolved. A run-scoped
id-to-name map accumulates, so later pages mostly hit memory.

Buffering the whole walk to batch it optimally was rejected: it would make `--resolve` silently
switch the command into ADR-0004's `collect` path, costing a paginated read its streaming property
and its time to first byte. A page is at most 500 records, so a page costs at most five extra
requests per relation type, and far fewer once the map warms.

This preserves ADR-0004's page atomicity: a page is emitted only once its resolution is settled, so
no record is emitted with a resolved block that a later request would have completed.

### 8. One blocking schema refresh per schema per run on an unknown hash

ADR-0005 §3 makes an unrecognised 40-character hex key force a schema refresh regardless of TTL. Mid
stream, that means the page holding the unknown hash is held, one schema request is issued, and the
page is emitted resolved.

**The refresh happens at most once per schema per run.** If the hash is still unknown afterwards, it
and every later unknown hash are emitted raw, absent from `custom_fields_resolved`, with one
`warning`:

```json
{"type":"warning","kind":"unknown_custom_field","resource":"deals","message":"1 field key is not in the schema; emitted raw."}
```

The cap exists for the pathological case: a field the schema never returns would otherwise trigger a
refresh on every page of an eighty-page walk. The cost of the cap is that a second field added
between the first refresh and the end of the run stays a raw hash until the next invocation, which is
a far smaller harm than an unbounded per-page drain on the shared budget.

Never refreshing at all was rejected because it reopens exactly the hole ADR-0005 §3 was written to
close: an admin adds a field at 10:00, the agent runs at 10:05, and the field is a raw hash all day
with the agent having no reason to reach for `--no-cache`.

### 9. Relation resolution has a default ceiling of 50 requests, raised by `--resolve-budget <n>`

Relation resolution is the one part of `--resolve` whose cost scales with the data rather than being
fixed. A 40,000-deal walk with 31,200 distinct organizations would spend 312 requests on legibility
alone — more than the walk itself — out of a daily budget shared with every colleague's integration.

So relation fetches get a per-run ceiling, **50 requests by default**, which covers 5,000 distinct
entities. `--resolve-budget <n>` raises or lowers it. `--max-requests` still applies on top and is
the harder of the two.

A single knob was rejected: `--max-requests` is unset by default, so relying on it alone means the
default `--resolve` run is unbounded — and the agent that typed it did not know it was asking for
hundreds of requests. A separate `--resolve-relations` flag was also rejected, because it re-splits
the one legibility flag ADR-0007 §6 deliberately fused.

The fixed-cost half of `--resolve` is not charged against `--resolve-budget`. A run reads one entity,
so it fetches one field schema, not six: **at most four requests on a cold cache** — the entity's
schema, `users`, `pipelines` and `stages` — and zero on a warm one. Commands that carry no pipeline
or stage cost fewer still.

### 10. Exhausting the resolution ceiling degrades; it never kills the walk

When `--resolve-budget` is reached mid walk, relation resolution stops for the remainder of the run,
one `warning` is emitted, and records continue with raw ids. The walk finishes and exits 0.

**`--max-requests` is not degraded against; resolution simply yields to it.** It is a *guard* in the
CONTEXT.md sense — locked point 4 calls it a hard ceiling that aborts before it is exceeded, and
ADR-0001 gives every guard exit 3. Resolution therefore never spends the last of its headroom: when
the remaining allowance would not survive a batch, relation resolution stops of its own accord,
exactly as if `--resolve-budget` had been reached, and the walk keeps its requests. If the walk's own
page fetches later reach `--max-requests`, the guard fires as it does everywhere else — exit 3,
`complete: false`, `reason: "max_requests"`. That is ticket 16's semantics and this ADR does not
weaken it.

The asymmetry is the point. An enrichment yields to a guard; it never consumes one and it never
overrides one.

```json
{"type":"warning","kind":"resolution_budget_exhausted","message":"Relation resolution stopped at the request ceiling; ids are unresolved."}
{"type":"summary","complete":true,"emitted":40000,"resolved":"partial","requests":136}
```

Aborting instead was rejected on ADR-0007 §8's argument: killing an otherwise perfect 40,000-record
walk over an ancillary lookup wastes the budget already spent and guarantees a re-run that spends it
again. Stopping pagination to finish resolving instead was rejected because it silently trades the
data the caller asked for against legibility they asked for only as an enrichment.

The accepted cost is that early records carry a resolved block and later ones do not. Section 11
makes that machine-detectable rather than something a consumer has to infer.

### 11. Every trailer carries `resolved`

The ADR-0002 `summary` trailer gains one field, always present:

- `"off"` — `--resolve` was not passed.
- `"full"` — every resolvable id and hash was resolved.
- `"partial"` — a ceiling was hit, a schema fetch failed, or an unknown hash survived the section 8
  refresh.

It is unconditional for the same reason ADR-0007 §5 keeps a structurally-zero `duplicates` field: a
trailer field that appears only sometimes is worse than one that is sometimes uninteresting.

### 12. Any resolution failure degrades to raw with one warning, and exits 0

A field schema that will not fetch, a `users` list that will not fetch, a batched relation request
that fails — each drops its own resolver for the whole run, emits one `warning` carrying an
ADR-0006 §6 `kind`, marks the trailer `partial`, and lets the walk finish.

This is ADR-0007 §8 applied by symmetry, including its deduplication: the cause is a single event, so
the warning is emitted once per run rather than once per record.

**The asymmetry ADR-0007 §8 drew holds here too.** Degradation applies to `--resolve` as an
enrichment. `pd fields list` — should ticket 19 create such a command — would fail hard, because
there the schema is the answer rather than a decoration.

## Assumptions recorded rather than decided

- **Only `--resolve` triggers a schema fetch.** Nothing else in `pd` reads a field schema: ADR-0006
  types `custom_fields` as `z.record(z.string(), z.unknown())`, so validation never consults it, and
  ADR-0002's output contract does not name fields. Eager or lazy fetching would therefore be work
  done for nobody.
- **`custom_fields_resolved` keys are emitted in the same order as `custom_fields`.** Output is
  compared with `diff` in practice, and a stable key order costs nothing to guarantee.
- **Under `--pretty`, resolution replaces rather than doubles.** The human table shows the label and
  drops the raw column; `--pretty` is already declared unstable by ADR-0002, so the diffability
  argument that forces additivity in NDJSON does not apply to it.

## Consequences

- `custom_fields` is invariant under `--resolve`. A diff between a resolved and an unresolved run
  shows only added keys.
- Duplicate custom field display names are a non-problem, permanently. No later decision needs to
  re-open it.
- ADR-0005's cache list is eight entries and its rule for schemas is now general. `pd cache info`
  reports eight possible entries.
- `pd` gains one flag, `--resolve-budget <n>`, which must appear in `AGENTS.md`, the manifest and
  `--help`. It is the second flag whose unit is requests; both mean network requests, per ADR-0005 §4.
- The `summary` trailer gains `resolved`, which the manifest must declare.
- Two new `warning` kinds: `unknown_custom_field` and `resolution_budget_exhausted`.
- A `--resolve` run on a cold cache costs at most four fixed requests before it fetches a single
  record: the entity's own field schema, `users` (20 tokens, v1), `pipelines` and `stages`. The other
  five schemas are cached entries a *different* command populates, never a cost this one pays.
- The map's *Field projection* question is now unblocked: it was waiting on this ADR, and a projection
  must now decide what it does to `custom_fields_resolved` as well as to `custom_fields`.
- The map's *Value formatting* question is narrowed but not closed: resolved values are fixed by
  section 4, raw ones are not.
