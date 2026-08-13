# 07 — Remaining live resources and the `get` verb

**What to build:** An agent runs `pd persons list`, `pd organizations list`, `pd activities list`, `pd products list` and gets the same NDJSON contract as `pd deals list`. It runs `pd deals get 42` and gets one record. It probes `pd deals update 42`, and one probe ends the search: the message says `pd` has no write commands **at all** and points at `pd manifest`.

**Blocked by:** 05

**Status:** ready-for-agent

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

- [ ] `persons`, `organizations`, `activities` and `products` all support `list` with the full ticket-05 contract
- [ ] `get <id>` works on all five live resources and emits one record plus a trailer
- [ ] `get` on a missing id is `not_found`, exit 1
- [ ] A list with zero matches is an empty success with `complete: true`, exit 0
- [ ] An unrecognised resource or verb is `usage`, exit 2, with a message stating `pd` has no write commands at all and pointing at `pd manifest`
- [ ] That message does not claim the only verbs are `list` and `get`
- [ ] `pd persons`, `pd people` and every alias probe behave per the no-aliases rule
- [ ] `products.prices` emits as an array of objects with the money and absence rules applied inside
- [ ] Timestamps pass through byte-for-byte on every resource
