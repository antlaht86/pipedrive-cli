# 02 — Generated clients and read-only generation gates

**What to build:** A maintainer runs the regeneration script and gets two committed Pipedrive clients — the v2 bulk client and a v1 client holding exactly one operation, `GET /users` — containing zero write operations. A CI gate fails the build if a regeneration ever reintroduces one.

**Blocked by:** 01

**Status:** ready-for-agent

Normative: ADR-0006 (validation placement), ADR-0007 (the narrow v1 users client), ADR-0013 §1–2 (read-only layers a and d).

Notes for the implementer:

- Two generation jobs, **separate output directories**. The `@hey-api` merge form is not used.
- Both jobs carry the generation filter `include: ['/^GET /']` — this is read-only layer (a).
- The v1 job is filtered to `GET /users` alone. Seven other `users` endpoints are excluded by name, as are `users/me`, `users/find`, followers, permissions, role assignments and role settings. The v1 spec needs no patch because `pd` defines the user record schema itself.
- `sdk.client: false`, so no ambient client exists and a generated function cannot be called without being handed a client the wrapper constructed.
- `sdk.validator: false`. Generated zod response schemas are run explicitly with `safeParse` inside the wrapper later (ticket 05), so a parse failure becomes a typed `PdError` rather than an untyped field shared with transport failures.
- Schema corrections are `parser.patch` entries against the **input spec**, never edits to generated output. Generated output is committed and never hand-edited. The starting patch list:
  - `additional_data.next_cursor` is typed as a required string but is `null` on the last page of every list. **This patch is load-bearing — a complete walk cannot work at all without it.**
  - `person_id` and `org_id` are typed non-nullable but return `null` for an unlinked deal.
- **Known probe with a named fallback.** Whether the `parser.patch` hoist of inline v2 response item schemas into `components/schemas` works in the *per-path* form is unverified; only the whole-spec form was checked. If the per-path form does not work, the fallback is a hand-written three-field envelope schema with generated record schemas. That fallback leaves the two-stage validation split intact and moves only its plumbing — do not stall on this, take the fallback and note it.

- [ ] Two generation jobs produce two committed output directories, v2 and v1-users-only
- [ ] The v1 output contains exactly one operation, `GET /users`
- [ ] Both outputs contain zero non-GET operations
- [ ] The three named `parser.patch` entries are applied against the input specs, and no generated file is hand-edited
- [ ] A documented regeneration script exists and is reproducible
- [ ] A CI gate asserts zero non-GET operations across both generated clients and **fails the build** when one appears
- [ ] ESLint `no-restricted-imports` forbids importing `**/generated/**` outside the client module, with a CI gate
