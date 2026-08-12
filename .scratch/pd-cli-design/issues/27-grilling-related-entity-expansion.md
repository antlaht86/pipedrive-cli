# Related-entity expansion: pulling the whole related record

Type: grilling
Status: resolved

Blocked by: 15, 16, 17

## Question

`--resolve` already answers "who is person 901" with a name
([ADR-0008](../../../docs/adr/0008-resolution-mechanics.md)). Can a caller instead pull the **whole**
related record — the person's email, the organisation's address — in one command, and what does that do
to the output contract?

- **Is it a distinct flag or an extension of `--resolve`?** ADR-0008 made `--resolve` one additive flag
  covering hashes, option labels, owner ids and six relation kinds, all landing in a parallel
  `custom_fields_resolved` block keyed by hash. A whole record is a different shape — it is not a label
  — so it needs somewhere else to live, or a reason to live there anyway.
- **Where does an expanded record go in NDJSON?** [ADR-0002](../../../docs/adr/0002-output-format.md)
  makes every line `type`-tagged with exactly one trailer. Options: nested inside the `record` line, a
  separate `type` the consumer joins by id, or a second NDJSON stream. Nesting bloats every record and
  duplicates the same organisation hundreds of times; a join-by-id line is smaller but makes the
  consumer do work.
- **Which ceiling bounds it?** [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md) settled the
  gate and [ADR-0010](../../../docs/adr/0010-budget-guard.md) §4 settled the rule that enrichment yields
  to `--max-requests` and never trips it. What is open is whether expansion shares `--resolve-budget`
  with relation resolution or needs a ceiling of its own — two enrichments competing for one allowance
  means the one that runs first starves the other, and which runs first is an implementation accident.
- **Does the `ids` batching still apply?** ADR-0008 batches up to 100 ids per request, which is what
  makes resolution affordable. Confirm the same parameter returns full records rather than a reduced
  projection, and confirm it exists on every entity a deal can point at — that is a fact to look up, not
  a decision.
- **What does a failed expansion do?** ADR-0008 §12's rule is that any resolution failure degrades to
  raw with one `warning` and exit 0. If expansion follows it, a record may carry an expansion on page 1
  and not on page 40, and the `resolved` trailer field would have to grow a sibling or a meaning.
- **Does it interact with field projection?** Ticket 25 is still open. A projection that names fields
  has to say whether it names them on the expanded record too.

Record as an ADR.

- **[ADR-0016](../../../docs/adr/0016-field-projection.md) §2 leaves this ticket a grammar question,
  deliberately unanswered.** The selector language is bare top-level names plus `custom_fields.<hash>`
  and nothing deeper, because `pd`'s records are one level deep plus that block. If expansion adds a
  nested block to the record, either it is selectable as a whole under its bare name, or this ticket
  extends the grammar — and extending it is a manifest-visible change under ADR-0016 §8.
- **ADR-0016 shrinks this ticket's cost problem before it starts.** Projection runs before the resolve
  prefetch, so an unselected `org_id` needs no lookup. Whatever expansion costs, `--fields` is already
  the lever that stops the caller paying for it unasked.

- **[ADR-0017](../../../docs/adr/0017-search-and-list-filtering.md) §6 hands this ticket an option and
  a fact.** `/itemSearch` carries `search_for_related_items`, which returns *"up to 100 newest related
  leads and 100 newest related deals for each found person and organization, and up to 100 newest
  related persons for each found organization"* in a **sibling `related_items` array**, not nested in
  the hit. ADR-0017 deliberately did not expose it: it is entity expansion that happens to live on a
  search endpoint, so it is this ticket's call. Three things about it are already settled by ADR-0017
  and need no rework here — the flag would apply only to `pd items search`, its results would include
  leads (out of scope, so they would have to be dropped client-side), and the API's own sibling-array
  shape is a working precedent for this ticket's "separate `type` the consumer joins by id" option.
- **ADR-0017 §3 adds a fifth record shape family.** `deal_search_hit` and its three siblings already
  carry `person_name` / `org_name` without `--resolve`, because the search API supplies them. If
  expansion applies to hits at all, it starts from a record that is partly expanded already; if it does
  not, this ticket must say so, because "expansion is a `list` affordance only" is a legitimate answer
  and a smaller surface.

## Answer

Recorded as [ADR-0018](../../../docs/adr/0018-related-entity-expansion.md).

**There is no expansion.** `pd` never emits a related entity's record — not nested, not as a sibling
line, not behind a flag. `--resolve` keeps ADR-0008's meaning exactly: legibility, not data. The
whole related record is fetched by a second command, and that recipe ships in `AGENTS.md`:

```
pd deals list --fields title,org_id
pd organizations list --ids 7,9,11
```

**The fact that decided it**: the `ids` parameter is a query parameter on the *same operation* as the
unfiltered list, so a batched fetch returns full records and the second command issues exactly the
request an in-run expansion would have issued. Request cost against the shared daily budget is
identical either way, which removes expansion's only real argument and leaves a pure trade of
contract surface against one extra invocation.

**The rival that was actually close** was deduplicated sibling `record` lines — it has API precedent
and `pd items search` already mixes `record_type` in one stream. It was rejected on the five contract
questions it would have forced (`emitted` arithmetic, its own ceiling beside `--resolve-budget`,
page-1-vs-page-40 partiality marking, `--fields` across two shapes in one stream, and ADR-0016 §2's
grammar reaching inside a nested block), every one of which the second command answers by never
asking.

**Answers the ticket's sub-questions:**

- *Distinct flag or extension of `--resolve`?* Neither.
- *Where does an expanded record go in NDJSON?* Nowhere; ADR-0002's line types are unchanged.
- *Which ceiling bounds it?* `--max-requests`, because the second command is an ordinary list command.
  No `--expand-budget` exists and `--resolve-budget` is untouched.
- *Does `ids` batching still apply?* Yes, and checking it found the gap this ticket actually closes —
  see below.
- *What does a failed expansion do?* Not applicable; an id the API omits is one deduplicated
  `unmatched_ids` warning at exit 0, which is the only surface this decision adds.
- *Interaction with field projection?* None. ADR-0016 §2's grammar is closed permanently and
  `manifest_version` does not move.

**One real gap found and closed.** ADR-0017 §7 exposed `--ids` without noticing the API's 100-id
ceiling, which would have broken the recipe at exactly the scale that motivated this ticket. ADR-0018
§3 amends it: `--ids` accepts any number, chunks client-side into requests of at most 100, and the
boundary is invisible — locked point 5's rule applied to a second kind of internal batching.

**`search_for_related_items` is refused** on three independent grounds: its `related_items` are
truncated *hits* rather than records (so it does not answer this question at all), it returns
out-of-scope leads, and it truncates at "100 newest" with no marker. Expansion is not a `list`-only
affordance either — the recipe applies to search hits unchanged, because ADR-0017 §3 already gives a
hit its `person_id` / `org_id`.
