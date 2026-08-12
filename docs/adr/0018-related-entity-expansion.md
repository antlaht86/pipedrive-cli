# ADR-0018: Related-entity expansion, and the two-command join that replaces it

Status: accepted
Date: 2026-08-12
Deciding ticket: [Related-entity expansion: pulling the whole related record](../../.scratch/pd-cli-design/issues/27-grilling-related-entity-expansion.md)
Amends: [ADR-0017](0017-search-and-list-filtering.md) §7 — `--ids` gains client-side chunking above the API's 100-id ceiling
Confirms: [ADR-0016](0016-field-projection.md) §2 — the selector grammar stays closed, and the question that ADR handed this one is answered by there being no nested block
Extends: [ADR-0006](0006-validation-placement-and-rejection.md) §6 — one new `warning` kind, `unmatched_ids`

## Context

[ADR-0008](0008-resolution-mechanics.md) made `--resolve` answer *"who is person 901"* with a name.
This ticket asked the next question: can a caller pull the **whole** related record — the person's
email, the organisation's address — in one command?

Three facts were established before choosing, two of them from `openapi-v2.yaml` rather than recalled.

**The `ids` parameter is capped at 100 and returns the ordinary list response.** Verified on
`/activities`, `/deals`, `/deals/archived`, `/persons`, `/organizations` and `/products`: *"Optional
comma separated string array of up to 100 entity ids to fetch. If filter_id is provided, this is
ignored. If any of the requested entities do not exist or are not visible, they are not included in
the response."* It is a query parameter on the **same operation** as the unfiltered list, so the
response schema is identical by construction — full records, not a projection. This is what makes a
second-command join cost the same as an in-run expansion.

**`search_for_related_items` does not return records.** Its `related_items` array holds
`ItemSearchItem` objects — the same truncated hit shape [ADR-0017](0017-search-and-list-filtering.md)
§3 normalises — so it is not entity expansion at all. It is *more hits*, capped at "100 newest" per
found entity, and it includes leads.

**The request cost is identical either way.** Expanding 3,000 organisations inside a deal walk costs
30 batched requests; fetching the same 3,000 with a second command costs 30 batched requests. The
shared daily budget cannot tell the two apart. So this decision is not a budget decision — it is
purely contract surface against one extra invocation.

## Decision

### 1. `pd` has no expansion flag

No `--expand`, no `--include`, no widening of `--resolve` past ADR-0008's labels. A `record` line
never carries another entity's record, nested or otherwise, and no command emits a related record the
caller did not name.

`--resolve` keeps exactly the meaning ADR-0008 gave it: **legibility, not data**. It turns an id into
a name so a human or an agent can read the line, and stops there.

### 2. The join is two commands, and it is documented as the answer

```
pd deals list --fields title,org_id            # → org_id 7, 9, 11 …
pd organizations list --ids 7,9,11             # → the whole organisation records
```

This is a recipe in `AGENTS.md`, not an apology for a missing feature. It has properties the flag
would not have:

- **Every organisation is fetched once and emitted once**, by construction. An in-record expansion
  duplicates the same organisation on every deal that points at it; a sibling-line expansion has to
  deduplicate deliberately and then explain the deduplication in the trailer.
- **The caller chooses the width of both halves.** ADR-0016's `--fields` applies independently to the
  deal walk and to the organisation fetch, so the join can be narrow on both sides. An expansion flag
  inherits one `--fields` list for two record shapes.
- **The second half is a normal list command** — normal trailer, normal `complete`, normal
  `--max-requests` accounting, normal `--resolve`. Nothing about it is new, so nothing about it can
  be inconsistent with the rest of `pd`.

The cost is real and is accepted: the agent makes one more invocation and carries the id set between
them. That is the same shape of cost ADR-0016 §3 already accepted when it made a caller run
`pd fields list` to learn a hash.

### 3. `--ids` chunks client-side above 100

The recipe leans on `--ids`, and ADR-0017 §7 exposed it without noticing the API's 100-id ceiling. A
join over a 40,000-deal walk names thousands of ids, so the ceiling would break the recipe at exactly
the scale that motivated the ticket.

**`--ids` accepts any number of ids. `pd` splits them into requests of at most 100 and emits one
stream.** There is no upper bound on the flag, no page-size flag, and no way for the caller to
observe the chunk boundary — this is locked point 5's rule ("pagination is complete and correct by
default, and the cursor is an internal detail") applied to a second kind of internal batching.

The mechanics follow existing rules rather than inventing any:

- Each chunk request counts against `--max-requests` like any other request, and the guard fires
  where it always fires — exit 3, `complete: false`, `reason: "max_requests"` (ADR-0010).
- Records stream chunk by chunk. Deduplication and the `duplicates` counter (ADR-0003) apply
  unchanged; a duplicated id in the flag's own value is deduplicated before chunking, so it costs
  nothing.
- `--limit` bounds the emitted records as usual, and `pd` stops issuing chunks once it is reached.
- `--ids` with `--filter-id` remains the usage error ADR-0017 §7 made it.

**An id that returns nothing is a warning, not an error.** The API silently omits ids that do not
exist or are not visible, which is precisely the failure the recipe must be able to see: a join that
quietly drops an organisation looks identical to an organisation with no fields. So if the run
returns fewer distinct ids than were named, it ends with one deduplicated `warning`:

```json
{"type":"warning","kind":"unmatched_ids","resource":"organizations","message":"3 of 412 requested ids returned no record; they do not exist or are not visible."}
```

One line per run, per ADR-0006 §6's deduplication-by-cause rule, counting rather than listing. Exit
stays 0 and `complete` stays `true` — the walk did everything it was asked to do, and the absence is
the CRM's answer, not a failure of `pd`.

### 4. The rival that was actually close: deduplicated sibling `record` lines

Nesting the related record inside the `record` line is easy to reject — it duplicates one
organisation across hundreds of deals and doubles the walk's byte count for a fact the caller may not
want. The serious alternative was **sibling lines**: `record_type: organization` lines interleaved in
the same stream, emitted once per id, joined by the consumer.

It is not a bad shape. It has API precedent in `related_items`, and `pd items search` (ADR-0017 §2)
already emits mixed `record_type` values in one stream, so "a mixed stream is confusing" is not
available as an argument. It was rejected on what it would have had to add:

| It would have had to decide | And the second command decides it by not asking |
| --- | --- |
| Whether `emitted` counts expansion lines | Two runs, two trailers, two unambiguous counts |
| Which ceiling bounds it — `--resolve-budget`, or a new `--expand-budget` | `--max-requests`, which already bounds every list command |
| How partiality is marked when an expansion stops on page 40 but ran on page 1 | A partial second command is a normal bounded run with a normal `reason` |
| What `--fields` means with two record shapes in one stream | One shape per invocation, so ADR-0016 applies unchanged |
| Whether ADR-0016 §2's grammar reaches into the expansion | It never has to |

Five contract questions, each of which grows the manifest and the surface an agent must learn, bought
in exchange for saving one invocation at identical request cost. **The trade is not close once the
budget neutrality of §"Context" is on the table** — expansion's whole appeal was that it might be
cheaper against Pipedrive, and it is not.

### 5. "We already fetched those bytes" is not a reason to emit them

During a `--resolve` run, the batched `ids` fetch of ADR-0008 §7 pulls **whole organisation records**
and keeps only the name. The obvious objection is that the expensive part is already paid, so
emitting the rest is free.

It is free against Pipedrive and expensive against the caller. The bytes would land in the agent's
context window, which ADR-0016 named as the one budget that cannot be refilled, and they would land
there **unasked** — the caller typed `--resolve` to make a line readable, not to receive a second
entity. The symmetry also fails in the other direction: with `--resolve` off there are no fetched
bytes at all, so the "free" expansion would exist only in combination with a flag that has nothing to
do with it.

And the caller who does want them pays the same price on demand, because §"Context" established that
the second command issues the same batched request `--resolve` would have issued.

### 6. `search_for_related_items` gets no flag, and search gets no expansion either

ADR-0017 §6 deferred the parameter to this ticket. It is refused, on three independent grounds, any
one of which is sufficient:

- Its `related_items` are `ItemSearchItem` **hits**, not records, so it does not answer this ticket's
  question even if it were exposed.
- It returns leads, which are out of scope (the map, ADR-0006), so `pd` would have to drop part of
  every response client-side — paying for bytes it deletes.
- It truncates at "100 newest" per found entity, with no marker distinguishing a truncated set from a
  complete one, which is the class of silent partiality ADR-0003 was written to refuse.

**Expansion is not a `list` affordance either, so the ticket's "list only" fallback does not arise.**
A search hit already carries `person_id`, `org_id` and their names (ADR-0017 §3), so the §2 recipe
applies to hits exactly as it applies to records: read the ids off the hits, then `--ids` the
entities. The hit's pre-supplied names are the strongest evidence for §1 — the one enrichment search
does supply for free is the *name*, which is exactly the boundary `--resolve` already draws.

## Assumptions recorded rather than asked

Implementation-level, decided rather than put to the user, per the map's altitude rule.

- **Chunk order is the caller's order.** Ids are emitted in the order they were named, chunk by chunk,
  after deduplication. Sorting them would be a silent reordering; `--sort-by` remains the way to ask
  for an order.
- **`unmatched_ids` counts distinct ids, not requests.** `pd` knows the set it asked for and the set
  of ids it emitted, so the count is a set difference computed at the end of the run and needs no
  per-chunk bookkeeping.
- **Chunking is invisible to `--verbose`'s contract but visible in its output.** ADR-0015's stderr is
  declared not a contract, so the per-request lines simply show what was issued; `ids` joins the
  ADR-0015 §6 query-value allowlist on the same reasoning ADR-0016 §10 used for `custom_fields` — it
  is a set of record identifiers the caller supplied, and it is the only way to answer "why is my
  join missing a row".

## Consequences

- **No new flag, no new record shape, no new trailer field, no new exit code, no new error variant.**
  The ADR-0001 union stays at thirteen. This is the first decision in the map whose net surface
  addition is one `warning` kind.
- **ADR-0016 §2's grammar is closed permanently.** The question that ADR handed forward — whether a
  nested block forces a deeper selector language — is answered by there being no nested block, so
  `manifest_version` does not move and no manifest-visible change ships.
- **ADR-0017 §7's `--ids` is materially stronger**, and the 100-id ceiling that would have surprised
  an implementer is pinned before implementation rather than discovered during it.
- `AGENTS.md` gains the two-command join as a worked recipe, next to the `pd fields list` recipe it
  already carries, and states plainly that `pd` will not fetch a related record the caller did not
  name.
- **Ticket 28 gains three offline tests**: `--ids` with 250 ids issues exactly three requests;
  `--ids` with duplicates issues the same requests as without them; and a fixture where the API omits
  two requested ids produces exactly one `unmatched_ids` warning and exit 0.
- One `warning` kind is added, `unmatched_ids`, which the manifest declares alongside the existing
  kinds.
