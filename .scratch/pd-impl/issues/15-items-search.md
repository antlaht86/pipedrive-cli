# 15 — `pd items search`

**What to build:** An agent asks "what does the CRM know about this name" and gets the answer in **one** request instead of four: `pd items search Acme` returns hits across deals, persons, organizations and products in one stream. Deal 42 and person 42 both survive deduplication, because the key is the pair, not the number.

**Blocked by:** 14

**Status:** ready-for-agent

Normative: ADR-0017 §items, ADR-0009 (command surface), ADR-0003 (page size).

Notes for the implementer:

- `items` has **neither `list` nor `get`** — `/itemSearch` has no by-id path and no unfiltered listing. `pd items list` and `pd items get 42` are unrecognised constructions, `usage`, exit 2.
- **`item_types` is pinned to `deal,person,organization,product` on every request and never defaulted**, so `itemSearch` cannot re-admit leads. `--types <a,b>` narrows **within that set only**.
- Page size for `/itemSearch` is **100**, not 500. The walker reads the ceiling **per endpoint**.
- Deduplication is keyed `(record_type, id)`, so deal 42 and person 42 do not collide.
- The four hit schemas and their normalisations come from ticket 14 unchanged.
- Minimum term length, the `--sort-by` refusal and `--limit` semantics all behave as on the entity searches.

- [ ] `pd items search <term>` returns hits across all four entity types in one stream
- [ ] `item_types` is sent pinned to the four types on every request and is never omitted
- [ ] `--types` narrows within the four and rejects anything outside them, exit 2 offline
- [ ] The page size for `/itemSearch` is 100 and the walker reads the ceiling per endpoint
- [ ] The `(record_type, id)` dedup key is verified on a mixed fixture where a deal and a person share an id (replay test)
- [ ] `pd items list` and `pd items get 42` are `usage`, exit 2
- [ ] Leads never appear in the output
