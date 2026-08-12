# ADR-0017: The search surface, and the filter flags on `list`

Status: accepted
Date: 2026-08-12
Deciding ticket: [The search surface, and what the stricter search rate limit costs](../../.scratch/pd-cli-design/issues/26-grilling-search-surface.md)
Amends: [ADR-0009](0009-command-surface-and-manifest.md) §1 and §3 — the grammar gains a third verb, and one resource that has neither `list` nor `get`
Extends: [ADR-0015](0015-stderr-and-run-diagnostics.md) §6 — six query parameters join the redaction allowlist, and one is refused entry
Confirms: [ADR-0011](0011-concurrency-and-retry.md) §10's conservative reading of research 01's open question 11
Amended by: [ADR-0018](0018-related-entity-expansion.md) §3 — §7's `--ids` accepts any number of ids and chunks client-side into requests of at most 100, which is the API's ceiling on the parameter

## Context

[ADR-0009](0009-command-surface-and-manifest.md) §2 left every search endpoint out of the first
surface and said why: search was this ticket's question, and it was waiting for a grammar to be
expressed in. It now has one.

Seven facts were established from `openapi-v2.yaml` before any choice was made. Five of them
overturned a premise the ticket or a prior ADR carried.

**A search hit is not a record.** `GET /deals/search` returns
`data.items[] = { result_score, item }`, where `item` is a *truncated projection* of the deal: `id`,
`type`, `title`, `value`, `currency`, `status`, `visible_to`, `owner {id}`, `stage {id, name}`,
`person {id, name}`, `organization {id, name}`. It is not the record `GET /deals` returns, and no
parameter makes it become one. The same is true of persons (`name`, `phones[]`, `emails[]`,
`organization {id, name}`), organizations (`name`, `address`) and products (`name`, `code`).

**The hit's `custom_fields` is an array of strings, not a hash-keyed object.** On
`/organizations/search` and `/products/search` the field is `string[]` — the *matched values*, with
no indication of which field each came from. Under the same JSON key that
[ADR-0008](0008-resolution-mechanics.md) §1 defined as a hash-keyed object.

**The hit's `type` key collides with the line's.** `item.type` carries `"deal"`, while
[ADR-0002](0002-output-format.md) makes `type` the line kind (`record` / `warning` / `summary` /
`error`).

**The search endpoints' `fields` query parameter collides with `--fields`.** It names the fields to
search *in* (`custom_fields`, `notes`, `title`, `name`, `email`, `phone`, `address`, `code`,
`description`), while [ADR-0016](0016-field-projection.md) made `--fields` the projection flag that
names the fields to *emit*.

**`/itemSearch`'s page cap is 100, not 500** — a different ceiling from every other paginated path in
the API, and from the entity search endpoints, which allow 500.

**The v2 list endpoints already carry a full filter vocabulary.** Enumerated mechanically, as the
ticket asked: `filter_id`, `ids`, `owner_id`, `person_id`, `org_id`, `deal_id`, `lead_id`,
`pipeline_id`, `stage_id`, `status`, `done`, `updated_since`, `updated_until`, `sort_by`,
`sort_direction`. Not one of them is exposed by `pd` today.

**`/itemSearch`'s `item_types` defaults to all eight** — `deal`, `person`, `organization`, `product`,
`lead`, `file`, `mail_attachment`, `project` — three of which are out of scope and one of which
ADR-0009 left out of the first surface.

## Decision

### 1. `pd` exposes search, as a third verb

`pd deals search <term>`, `pd persons search <term>`, `pd organizations search <term>`,
`pd products search <term>`.

The two rejected shapes were rejected on the same fact.

`pd deals list --search <term>` is **dead on arrival**: it would make a flag change the record shape,
which is the exact invariant ADR-0016 §5 and ADR-0008 §1 exist to protect. A consumer would have to
branch on a flag it did not set, on every field of every line.

A verbless `pd search <term>` was rejected in section 2's favour.

This amends ADR-0009 §1. The grammar is unchanged in form — `pd <resource> <verb> [arg]` — but the
verb inventory is three, not two. ADR-0009 §6 already anticipated this and forbade the refusal message
from naming the verb inventory; that wording needs no change and is now load-bearing rather than
merely cautious.

The term is a **positional argument**, not a flag. It is the one thing every search invocation must
have, and ADR-0009 §1 already established a positional slot for `get`'s id.

### 2. Cross-entity search is a tenth resource, `items`, and it has only `search`

`pd items search <term>` wraps `/itemSearch`.

An agent's first question about a name it has read in a ticket or an email is *"what does the CRM know
about this"*, with no entity type in hand. Without this command, the answer costs four requests and 80
tokens; with it, one request and 20.

Making it a resource rather than a fourth verbless exception group is the point. ADR-0009 §8 declared
its exception list complete, and a fourth entry would mean an agent constructing a command must check
a growing list of special cases before trusting the grammar. `items` is Pipedrive's own noun — the
endpoint is `itemSearch` — so ADR-0009 §5's "Pipedrive's nouns win" applies unchanged.

The cost is a real amendment to ADR-0009 §3: `items` has no `list` and no `get`, because `/itemSearch`
has no by-id path and no unfiltered listing. §3 becomes **every resource has `list` and `get` where v2
offers the paths, and `items` offers neither**. `pd items list` and `pd items get 42` exit 2 with
`unknown_command`, the same as any other unrecognised construction.

**`item_types` is fixed to `deal,person,organization,product`** and is never sent as the default.
`--types` narrows within that set and cannot widen beyond it; a value outside it is a usage error,
exit 2, offline. Leads, files and mail attachments are out of scope (the map, and
[ADR-0006](0006-validation-placement-and-rejection.md)), and projects are out of ADR-0009 §2's first
surface. The scope boundary holds: `itemSearch` does **not** re-admit leads through the back door,
because `pd` names the four types explicitly on every request rather than accepting the API's default.

`/leads/search` therefore gets no command, even though it is v2 and would have come free.

### 3. A hit is its own record type, and `pd` normalises it

Search commands emit `record` lines whose `record_type` is `deal_search_hit`, `person_search_hit`,
`organization_search_hit` or `product_search_hit`. Never `deal`. An agent that reads `record_type` —
which ADR-0009's assumptions already require it to do — cannot mistake a hit for a record.

The `item` object is **flattened into the record body**, with `result_score` as a top-level sibling.
Nesting it under `item` was rejected: it would make `--fields id` mean something different on
`pd deals search` than on `pd deals list`, for no gain.

Four normalisations are applied, and `pd` owns the hit schema outright — ADR-0006 §2 already made the
emitted shape `pd`'s rather than Pipedrive's, so this is that rule applied, not an exception to it:

| Pipedrive returns | `pd` emits | Why |
| --- | --- | --- |
| `type: "deal"` | *dropped* | collides with ADR-0002's line kind; `record_type` already carries it |
| `owner: {id}` | `owner_id` | ADR-0008 §3's table keys off `owner_id` |
| `stage: {id, name}` | `stage_id`, `stage_name` | same table, both keys already defined |
| `person`/`organization`: `{id, name}` | `person_id`/`org_id`, `person_name`/`org_name` | same table |
| `custom_fields: string[]` | `matched_custom_field_values` | ADR-0008 §1 defines `custom_fields` as a hash-keyed object; two types under one JSON path is the failure ADR-0008 §1 rejected in-place enrichment to avoid |
| `notes: string[]` | `matched_notes` | notes are out of scope as a resource; a bare `notes` key would read as one |

The two renames are the only places in `pd` where a Pipedrive field name is not carried through, and
they are deviations from ADR-0009 §5 taken deliberately: the alternative is a JSON path whose type
depends on which command produced the line.

A consequence worth stating because it looks like a violation and is not: a search hit carries
`stage_name`, `person_name` and `org_name` **without `--resolve`**, because the API supplied them.
ADR-0008's additive rule governs siblings `pd` adds, not names the API already sent. The shape does not
change with the flag, which is the invariant that actually matters.

### 4. `--resolve` is accepted on search, and resolves owner ids only

The hit carries no custom field hashes — `matched_custom_field_values` is a list of values with no
keys, so nothing in ADR-0008 §1 applies — and its relations arrive pre-named per section 3. The one
unresolved id left is `owner_id`.

It resolves from the cached `users` list at **zero requests** (ADR-0005, ADR-0007 §5), so `--resolve`
on a search command cannot spend a request, cannot reach `--resolve-budget`, and cannot degrade except
when the cached user list is itself unavailable — in which case ADR-0007's rule stands unchanged: the
sibling key is absent, one `warning`, `resolved: "partial"` on the trailer.

Rejecting the flag as a usage error was rejected: an agent that passes a global flag uniformly across
commands would then have to learn a per-command exception table, which is precisely the cost ADR-0009
§5 refused to impose.

### 5. The search-scope parameter is `--search-in`, never `--fields`

`--search-in title,notes`. The permitted values differ per resource and the manifest enumerates them;
a value outside the set is a usage error, exit 2, offline.

Two meanings of `--fields` would be the worst possible collision, because both are plausible in the
same invocation and neither errors: `pd deals search Acme --fields title` reads equally well as
"search in the title" and "emit only the title". `--fields` keeps ADR-0016's meaning everywhere,
including on search commands, where the selectable set is section 3's hit schema.

`custom_fields.<hash>` is **not** a legal `--fields` selector on a search command — there are no hashes
in a hit — so it is exit 2 offline, per ADR-0016's rule that an unknown name is caught without a
request.

### 6. The remaining search flags

| Flag | Endpoint parameter | Commands |
| --- | --- | --- |
| `--exact` | `exact_match` | all search commands |
| `--types <a,b>` | `item_types` | `pd items search` only, constrained per §2 |
| `--search-in <a,b>` | `fields` | all search commands |
| `--person-id`, `--organization-id`, `--status` | same | `pd deals search` |
| `--organization-id` | same | `pd persons search` |

**The minimum term length is enforced offline.** Two characters, or one with `--exact`. Below it, exit
2 with `usage` and **zero requests** — the API would reject it anyway, and spending a request to learn
a rule the spec states plainly is a request spent against a shared budget for nothing.

`--sort-by` and `--sort-direction` are **usage errors on search commands**, exit 2. Search results are
relevance-ordered and the endpoints accept no sort parameter; accepting the flag and ignoring it would
be a silent lie about ordering.

`search_for_related_items` is **not** exposed here. It is
[ticket 27](../../.scratch/pd-cli-design/issues/27-grilling-related-entity-expansion.md)'s question —
it is entity expansion that happens to live on a search endpoint — and that ticket now carries the
context.

`/itemSearch/field` gets no command in the first surface. It answers "which values exist in this one
field", returns a third response shape that is neither record nor hit, and its `match` modes
(`exact`/`beginning`/`middle`) are an autocomplete affordance for a human typing into a box. An agent
has `pd fields list` for the schema and the search commands for the records. Adding it later is
additive under [ADR-0014](0014-distribution.md)'s semver rule; it is not out of scope, merely not in
the first surface, in exactly ADR-0009 §2's sense.

### 7. `list` gains filter flags, and they are command-scoped

The enumeration is done, so the decision is which of it survives:

| Flag | Parameter | Commands |
| --- | --- | --- |
| `--ids <a,b,…>` | `ids` | deals, persons, organizations, activities, products |
| `--owner-id <n>` | `owner_id` | deals, persons, organizations, activities, products |
| `--person-id <n>` | `person_id` | deals, activities |
| `--org-id <n>` | `org_id` | deals, persons, activities |
| `--deal-id <n>` | `deal_id` | activities, persons |
| `--pipeline-id <n>` | `pipeline_id` | deals; also `stages` |
| `--stage-id <n>` | `stage_id` | deals |
| `--status <s>` | `status` | deals (`open`/`won`/`lost`/`deleted`) |
| `--done` / `--not-done` | `done` | activities |
| `--updated-since <t>` | `updated_since` | deals, persons, organizations, activities, products |
| `--updated-until <t>` | `updated_until` | deals, persons, organizations, activities |
| `--sort-by <f>` | `sort_by` | per-resource enum, from the spec |
| `--sort-direction <d>` | `sort_direction` | `asc` / `desc` |
| `--filter-id <n>` | `filter_id` | deals, persons, organizations, activities, products |

`lead_id` on `/activities` is dropped: leads are out of scope, so a flag whose only use is to name one
would be surface with no reachable meaning.

**These are command-scoped, not global.** ADR-0009's flat global table stays at the nine flags
ADR-0016 §1 closed it on. The manifest already carries per-command flags, so this is an append to
existing structure rather than a new one.

**`--updated-since` is the single most valuable entry in this table**, and it is worth naming why:
combined with `--sort-by update_time`, it is the honest incremental read that
[ADR-0003](0003-pagination-bounding-and-partiality.md) §6 refused to fake with a resumption token. It
does not promise a cursor's exactness — a record updated during the walk can appear twice, which is
what ADR-0003's `duplicates` counter is for — but it lets a harness read a day's changes instead of a
CRM's history, which is the only lever in this ADR that meaningfully reduces load on the shared
budget.

**`--filter-id` is exposed even though `pd` cannot enumerate filters.** Saved Filters are v1-only and
out of scope, so an agent has no route to a filter id and must be handed one — from a Pipedrive URL,
or from a harness's configuration. That is an unusual flag to put in front of an agent, and it earns
its place because a saved filter is server-side selection at zero extra requests, which is strictly
better for the shared budget than fetching everything and discarding most of it. The manifest marks it
`"enumerable": false` so an agent knows not to look for a command that lists the values, and
`--help` says where a human gets one.

One API behaviour is documented rather than corrected: **`filter_id` causes the API to ignore `ids`**.
`pd` refuses the combination as a usage error, exit 2, offline. Sending both and letting one silently
lose is the class of surprise ADR-0016 §5 was written to prevent.

### 8. Search shares `--max-requests`, and gets no ceiling of its own

The ticket's live question was whether search needs its own budget the way `--resolve` needed
`--resolve-budget`. It does not, and the asymmetry has a reason rather than a preference behind it.

`--resolve-budget` exists because resolution requests are **implicit**: the caller asks for one deal
walk and `pd` decides, on its own, to issue fifty more requests it never mentioned. A search command's
requests are the requests the caller asked for. `--limit` bounds the walk, `--max-requests` bounds the
run, and both already mean exactly what they mean everywhere else.

A second ceiling would also have to be honest about a cost `pd` cannot see. Research 01 open question
11 — whether a search request spends the search allowance, the general allowance, or both — is
documented nowhere. **ADR-0011 §10's conservative reading is confirmed, not overturned: a search
request is assumed to spend both.** The reason is asymmetric consequence, the same argument
[ADR-0001](0001-error-model-and-exit-codes.md) used for the ambiguous 429: being wrong in the cautious
direction costs a few seconds of gate time, and being wrong in the other direction earns the whole
company a Cloudflare 403 (ADR-0010 §7). An unfalsifiable assumption is not a reason to guess
optimistically.

ADR-0011 §10's `search` rate-gate family arrives as designed — 5 requests per 2 seconds, half of the
documented 10 — with no rework. `pd items search` and the four entity searches share **one** family
key, because the ceiling is documented as a property of the Search API rather than of any one path.

### 9. `--limit` means what it always meant, and the trailer gains nothing

`--limit` counts records, per ADR-0003 §1. `complete`, `emitted`, `skipped` and `duplicates` keep
their definitions, and there is no fourth subtractive counter.

The ticket asked whether one was needed. It is not, and the reasoning is the one ADR-0016 §5 set up:
a record excluded by a search term or a filter flag was **never fetched**. Server-side selection is
not `pd` dropping a record; it is `pd` asking a narrower question. There is nothing for a counter to
count.

Deduplication (ADR-0003 §4) applies to search too, keyed by `(record_type, id)` rather than `id`
alone. On `pd items search` a deal 42 and a person 42 are different records and must not collide.

Two page-cap facts are internal and invisible in the contract: entity search pages at 500, `itemSearch`
at 100. The walker reads the ceiling per endpoint rather than assuming 500.

**Relevance ordering makes a partial search more useful than a partial list, not less.** A truncated
list is an arbitrary prefix; a truncated search is the best matches. This changes no behaviour — there
is still **no default `--limit`**, because a default would be a silent bound and ADR-0003 refused those
— but `AGENTS.md` and the manifest say it, because `--limit 20` is the right instinct on a search and
the wrong one on a list, and an agent has no way to derive that from the flag alone.

### 10. Redaction: six parameters join the allowlist, `term` never does

ADR-0015 §6 prints query values only for an allowlist. It gains `exact_match`, `item_types`, `fields`,
`status`, `person_id` and `organization_id` — closed enums and numeric ids, following the precedent
`ids` already set — and the section 7 filter parameters on the same reasoning: `owner_id`, `org_id`,
`deal_id`, `pipeline_id`, `stage_id`, `done`, `filter_id`, `updated_since`, `updated_until`.

**`term` is refused, permanently.** A search term is the single most sensitive value `pd` ever puts on
the wire — it is a customer name, a deal name, or whatever a human typed — and it prints as
`[redacted]` under `--verbose` like every non-allowlisted value. This ADR does not want the opposite,
and records the refusal so a later session does not read the omission as an oversight.

## Assumptions recorded rather than asked

Per the map's altitude rule, and per the user's explicit instruction on this ticket that nothing
answerable from the material be put to them. Every point below was decided.

- **`pd items search` emits mixed `record_type` values in one stream**, interleaved in the API's
  relevance order rather than grouped by type. Grouping would require buffering the whole walk, which
  ADR-0004 forbids for exactly the reason ADR-0008 §7 gives.
- **`result_score` is emitted always and is selectable via `--fields`**, not mandatory the way `id` is.
  An agent that projects it away has said it does not want it.
- **Timestamp flags take the API's RFC3339 format verbatim** (`2026-01-01T10:20:00Z`) and are validated
  offline. Accepting a friendlier form would mean `pd` owning a date parser, and interpreting a bare
  date in a timezone the map's *Value formatting* question has not settled.
- **`--not-done` exists rather than `--done=false`.** `util.parseArgs` boolean flags have no negative
  form, and a three-state flag whose absence means "both" needs two spellings, not a value.

## Consequences

- ADR-0009 §1 and §3 are amended: three verbs, and one resource with neither `list` nor `get`.
  `manifest_version` does **not** increment — every change here is additive, per ADR-0009 §9.
- The manifest gains five commands, their per-command flag tables, their `--fields` selectable-field
  lists (ADR-0016 §11), and `delivery: "streams"` for all five.
- ADR-0001's error union gains **no variant** and the exit codes are unchanged. Every failure mode
  invented here is `usage`, exit 2, offline.
- ADR-0006's schema list grows by four hit schemas. They are `pd`'s own, strict, and unrelated to the
  record schemas of the same entities.
- `AGENTS.md` gains the third verb, the `items` resource, the hit-versus-record distinction, the
  `--limit`-on-search note from section 9, and the sentence that `--search-in` and `--fields` are
  different things.
- Ticket 27 inherits `search_for_related_items` as one of its options, on an endpoint this ADR has
  already shaped.
- The map's *Value formatting* question is untouched. A hit carries `value` and `currency` as raw
  fields, so it inherits whatever that question decides and does not decide it here.
