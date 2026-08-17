# 15 — `pd items search`

**What to build:** An agent asks "what does the CRM know about this name" and gets the answer in **one** request instead of four: `pd items search Acme` returns hits across deals, persons, organizations and products in one stream. Deal 42 and person 42 both survive deduplication, because the key is the pair, not the number.

**Blocked by:** 14

**Status:** done

Normative: ADR-0017 §items, ADR-0009 (command surface), ADR-0003 (page size).

Notes for the implementer:

- `items` has **neither `list` nor `get`** — `/itemSearch` has no by-id path and no unfiltered listing. `pd items list` and `pd items get 42` are unrecognised constructions, `usage`, exit 2.
- **`item_types` is pinned to `deal,person,organization,product` on every request and never defaulted**, so `itemSearch` cannot re-admit leads. `--types <a,b>` narrows **within that set only**.
- Page size for `/itemSearch` is **100**, not 500. The walker reads the ceiling **per endpoint**.
- Deduplication is keyed `(record_type, id)`, so deal 42 and person 42 do not collide.
- The four hit schemas and their normalisations come from ticket 14 unchanged.
- Minimum term length, the `--sort-by` refusal and `--limit` semantics all behave as on the entity searches.

- [x] `pd items search <term>` returns hits across all four entity types in one stream
- [x] `item_types` is sent pinned to the four types on every request and is never omitted
- [x] `--types` narrows within the four and rejects anything outside them, exit 2 offline
- [x] The page size for `/itemSearch` is 100 and the walker reads the ceiling per endpoint
- [x] The `(record_type, id)` dedup key is verified on a mixed fixture where a deal and a person share an id (replay test)
- [x] `pd items list` and `pd items get 42` are `usage`, exit 2
- [x] Leads never appear in the output

## Comments

**2026-08-17 — verification.** The work landed in `c35e48f`. Every box is proven by a named test in
`test/search.test.ts`.

| Box | Evidence |
| --- | --- |
| Four hit types in one stream | "items search streams all four hit types, deduplicates by type and excludes leads" |
| `item_types` pinned on every request | the replay transport matches on query, so the pinned value is asserted by every `itemSearch` fixture; "items search pins its types on every 100-item page" asserts it again on the cursor page, where an omission would be easiest |
| `--types` narrows within the four, exit 2 outside | "items refuses types outside its fixed set offline" — `lead`, `deal,project` and a trailing comma, each exit 2 with zero dispatches |
| Page size 100, ceiling read per endpoint | the `itemSearch` fixtures carry `limit: 100` and the entity-search fixtures `limit: 500`, both matched rather than ignored |
| `(record_type, id)` dedup on a shared id | the mixed fixture gives the deal and the person **the same id, 42**; both emit, and the repeated deal is the one `duplicates: 1` |
| `items list` and `items get 42` are `usage`, exit 2 | "items has neither list nor get" |
| Leads never appear | the mixed fixture includes a `type: "lead"` item; it is absent from the output and counted as the one `skipped` |

One box was true but under-asserted, and is now: `items list` / `items get` asserted exit 2 without
asserting the code. Exit 2 alone would also be satisfied by a different refusal, and the box names
`usage`.
