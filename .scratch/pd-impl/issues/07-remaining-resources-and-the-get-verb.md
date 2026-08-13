# 07 — Remaining live resources and the `get` verb

**What to build:** An agent runs `pd persons list`, `pd organizations list`, `pd activities list`, `pd products list` and gets the same NDJSON contract as `pd deals list`. It runs `pd deals get 42` and gets one record. It probes `pd deals update 42`, and one probe ends the search: the message says `pd` has no write commands **at all** and points at `pd manifest`.

**Blocked by:** 05

**Status:** done

Normative: ADR-0009 (command surface), ADR-0001 (error model), ADR-0020 (value formatting).

## The grammar

`pd <resource> <verb> [arg] [flags]`. Three verbs: `list`, `get`, `search`.

Ten resources total: `deals`, `persons`, `organizations`, `activities`, `products`, `pipelines`, `stages`, `users`, `fields`, `items`. This ticket delivers the five live-fetch ones; the four cached ones arrive in ticket 08 and `items` in tickets 14–15.

**Spec ruling, not negotiable:** an unrecognised command is `code: "usage"`, exit 2. ADR-0009 §6 and ADR-0017 §2 write `code: "unknown_command"` — they are wrong. ADR-0001 owns the union and wins; **`unknown_command` is not a `code`**. The response to it is identical to any other usage error, so it earns no variant.

Notes for the implementer:

- **Pipedrive's nouns win.** `persons`, not `people`. **No aliases, no synonyms, no short flags.** One spelling per concept.
- `list` and `get` exist wherever v2 offers the paths.
- The unrecognised-command message must **not** claim the only verbs are `list` and `get`.
- `not_found` is for a named single resource that does not exist. **A list with no matches is an empty success**, not `not_found`.
- `forbidden` is a valid credential with insufficient permission — distinct from `auth`.
- `products.prices` is the one nested block in the contract, kept as an array of objects. Money inside it is a JSON number with its currency sibling, and the omit-absent rule applies inside those objects too. It is selectable whole later; no path reaches inside it.
- `expected_close_date`, `due_date` and `due_time` are **account-local wall clock**. `due_date` and `due_time` stay two fields. The account timezone is **never read**.
- `arr`, `mrr` and `acv` are read in the deal's `currency`, same rule as `value`.

- [x] `persons`, `organizations`, `activities` and `products` all support `list` with the full ticket-05 contract
- [x] `get <id>` works on all five live resources and emits one record plus a trailer
- [x] `get` on a missing id is `not_found`, exit 1
- [x] A list with zero matches is an empty success with `complete: true`, exit 0
- [x] An unrecognised resource or verb is `usage`, exit 2, with a message stating `pd` has no write commands at all and pointing at `pd manifest`
- [x] That message does not claim the only verbs are `list` and `get`
- [x] `pd persons`, `pd people` and every alias probe behave per the no-aliases rule
- [x] `products.prices` emits as an array of objects with the money and absence rules applied inside
- [x] Timestamps pass through byte-for-byte on every resource

## What shipped, and what it changed

Five findings needed a ruling and are ratified as [ADR-0025](../../../docs/adr/0025-the-shadowed-line-key-nested-absence-and-the-refusal-that-teaches.md):

1. **An activity's own `type` shadowed the line discriminator.** A `record` line is flat and `type` is ADR-0002's tag, so an activity serialised naively emits `{"type":"call", …}`. The field is renamed to `activity_type` on output; nesting every record under a `record` key was the rival and was rejected on blast radius. `NdjsonWriter` now owns a reserved set and throws `internal` on a collision no rename covers.
2. **ADR-0020 §7's "`products.prices` is the only nested block" is false.** Persons, organizations and activities carry seven more. §6's omission rule is applied recursively, at every depth; array elements are never dropped, only object keys.
3. **`unknown_command` is not a `code`** — the ticket's ruling, now in an ADR. The refusal is a full `error` trailer, and it quotes back only the leading non-flag words so a `--token` value never reaches an error object.
4. **`get` is a one-page generator** through the same `stream()` loop, with its own by-id envelope. A single record that fails the schema is `invalid_response`, not an empty success; `not_found` stays with the 404.
5. **The hoist gained an `allOf` flatten.** `pd products list` had no record schema at all, because a product is an `allOf` of `BaseProduct` and `PricesArray`. The correction is a `parser.patch`, per ADR-0006 §9.

Left for the tickets that own them: `--limit` and `--max-requests` (06), the nullability patch list (21) — `bun run openapi-ts` was re-run here and its output committed, but no field moved into `NULLABLE_IN_PRACTICE`, so a live account still meets ticket 21's fault.
