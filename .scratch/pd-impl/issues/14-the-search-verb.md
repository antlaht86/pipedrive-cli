# 14 — The `search` verb

**What to build:** An agent runs `pd deals search Acme` and gets search hits — tagged `record_type: "deal_search_hit"`, never `"deal"`, so a truncated projection can never be mistaken for a full record. `--limit 20` gives the twenty **best** matches. A one-character term is refused offline with exit 2 rather than spending a shared-budget request to learn a rule the spec states plainly. `--sort-by` is a usage error, because `pd` will not lie about ordering it cannot control.

**Blocked by:** 10, 13

**Status:** ready-for-agent

Normative: ADR-0017 (search surface and normalisation), ADR-0003 (bounding), ADR-0011 (the search gate family).

## A hit is not a record

`pd` owns the four hit schemas outright. `record_type` is `deal_search_hit`, `person_search_hit`, `organization_search_hit` or `product_search_hit`.

The `item` object is **flattened into the record body**, with `result_score` as a top-level sibling, so `--fields id` means the same thing on `search` as on `list`.

Normalisations:
- `type` is **dropped** — it collides with the line kind.
- `owner: {id}` becomes `owner_id`.
- `stage`, `person` and `organization` objects become the `*_id` / `*_name` pairs already defined.
- `custom_fields: string[]` becomes **`matched_custom_field_values`**.
- `notes: string[]` becomes **`matched_notes`**.

Those two renames are the only places a Pipedrive field name is not carried through, and they exist so that **no JSON path holds two types**.

Notes for the implementer:

- **`search` is a distinct verb, not a flag.** A flag must never change the shape of a record.
- A hit carries `stage_name`, `person_name` and `org_name` **without `--resolve`**, because the API supplied them. **The shape does not change with the flag** — that is the invariant that matters. Under `--resolve` only owner ids resolve, at zero requests.
- Command-scoped search flags: `--exact`, `--search-in <a,b>`, `--person-id`, `--organization-id`, `--status` (on `pd deals search`).
- **`--search-in` names where to search; `--fields` names what to emit.** Two plausible readings of one flag must not silently diverge.
- Minimum term length is enforced **offline**: two characters, or one with `--exact`.
- **`--sort-by` and `--sort-direction` on a search command are usage errors, exit 2.**
- `--limit` on a search bounds to the best matches — a bounded search is more useful than a bounded list, not less.
- Page size is the endpoint maximum, 500 for entity search.
- Deduplication on search is keyed `(record_type, id)`.
- Search sits in its own burst gate family at 5 requests per 2 seconds and is assumed to spend both allowances.
- **Search shares `--max-requests` and gets no ceiling of its own**, because its requests are the ones the caller asked for.
- `/leads/search`, `/itemSearch/field` and `search_for_related_items` get **no command**. `search_for_related_items` is refused because its `related_items` are hits rather than records, it returns leads, and it truncates at "100 newest" with no marker.

- [ ] `search` exists on `deals`, `persons`, `organizations` and `products`
- [ ] Hits carry `*_search_hit` record types and never the bare entity name
- [ ] The `item` object is flattened with `result_score` as a top-level sibling, so `--fields id` behaves as on `list`
- [ ] `type` is dropped, `owner` becomes `owner_id`, and the `stage` / `person` / `organization` objects become `*_id` / `*_name` pairs
- [ ] `custom_fields: string[]` emits as `matched_custom_field_values` and `notes: string[]` as `matched_notes`
- [ ] The hit shape is identical with and without `--resolve`, and `--resolve` dispatches zero extra requests
- [ ] A one-character term is exit 2 offline; one character with `--exact` is accepted
- [ ] `--sort-by` and `--sort-direction` on a search are exit 2 offline with zero dispatches
- [ ] `--limit 20` returns the twenty best matches and exits 0
- [ ] Search requests use the `search` gate family at 5 per 2 s
- [ ] No command exists for `/leads/search`, `/itemSearch/field` or `search_for_related_items`
