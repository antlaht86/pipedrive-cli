# 02 — Generated clients and read-only generation gates

**What to build:** A maintainer runs the regeneration script and gets two committed Pipedrive clients — the v2 bulk client and a v1 client holding exactly one operation, `GET /users` — containing zero write operations. A CI gate fails the build if a regeneration ever reintroduces one.

**Blocked by:** 01

**Status:** done

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

- [x] Two generation jobs produce two committed output directories, v2 and v1-users-only
- [x] The v1 output contains exactly one operation, `GET /users`
- [x] Both outputs contain zero non-GET operations
- [x] The three named `parser.patch` entries are applied against the input specs, and no generated file is hand-edited
- [x] A documented regeneration script exists and is reproducible
- [x] A CI gate asserts zero non-GET operations across both generated clients and **fails the build** when one appears
- [x] ESLint `no-restricted-imports` forbids importing `**/generated/**` outside the client module, with a CI gate

## Comments

**2026-08-13 — implemented.**

- `openapi-ts.config.ts` replaces the stale `openapi-ts.ts`, exporting the two-job array of
  ADR-0007 §1: v2 to `src/lib/pipedrive/v2/generated`, v1 to `src/lib/pipedrive/v1/generated`.
  `bun run openapi-ts` is now the `openapi-ts` CLI bin rather than `npx tsx`, which research 06
  flagged as fragile under Node's export conditions. `@hey-api/openapi-ts` is pinned to the exact
  version every empirical claim in research 06 was verified at, `0.99.0`.
- Measured on the committed output: v2 has 66 GET operations and zero writes, v1 has exactly one
  export, `getUsers`. Neither `sdk.gen.ts` imports `./client.gen`, which is what `sdk.client: false`
  buys — the compile-time choke point.
- **The hoist probe resolved, and the fallback was not needed.** The per-path `parser.patch` forms
  cannot hoist: `patch.responses` is keyed by component name and Pipedrive's response bodies are
  inline and unnamed, and a `patch.operations` callback receives the operation node, which has no
  route to `components`. The hoist is therefore done in the whole-spec `patch.input` form, which
  research 06 §2.3 had already verified against this spec. **Ticket 05 gets real generated record
  schemas** — `zGetDealsItem` and its siblings — so ADR-0006 §2's two-stage split is generated on
  both stages, and the hand-written envelope fallback is not taken.
- The three nullability corrections landed: `next_cursor`, `person_id` and `org_id` are
  `.nullable()` in `zod.gen.ts`. The OpenAPI 3.0 spelling `nullable: true` is used; the 3.1 spelling
  silently degrades the schema to `z.unknown().nullable()`.
- `@hey-api/client-fetch` is **not** a dependency. The generator vendors the client into
  `generated/client/` and `generated/core/`, verified by regenerating with the package removed. So
  `pd` has exactly one runtime dependency so far, `zod`.
- `test/generated-read-only.test.ts` is layer (d). It reads the **committed** output rather than
  regenerating, so it fails on the change that introduced a write and not on the day Pipedrive edits
  its published spec. It also drives a forbidden import through ESLint, so deleting the
  `no-restricted-imports` rule fails the suite instead of quietly passing lint. The write-method
  detector is exercised against a synthetic reintroduced `addDeal` first, so the gate is known to
  fire. All of it runs in CI leg 1 through `bun test` and `bun run lint`; no workflow change was
  needed.
- **For ticket 04:** `generated/client.gen.ts` still constructs a module-level `client` with a bare
  `baseUrl` and no guarded fetch — the generator emits it regardless of `sdk.client: false`. The
  wrapper must build its own client from `generated/client` and never import `client.gen`. The
  ESLint ban does not help there, because the wrapper is the exempt directory.
- **For the wrapper, ticket 04 and ticket 07:** the v2 filter is the ticket's `/^GET /`, so
  `getUserFollowers` is generated. ADR-0007's consequence — a caller cannot ask `pd` for a user's
  followers — is therefore a promise the command table keeps, not one generation keeps.
- After review: `zod` is pinned exactly rather than left on a caret range, because the zod plugin
  declares `compatibilityVersion: 4` and the committed `zod.gen.ts` is generated against one zod.
  The hoist also throws on a response-title collision with two different record shapes — no title
  collides in today's spec, but the silent alternative is a `$ref` validating the wrong record.
- `src/lib/pipedrive/fetch-globals.d.ts` maps the global `BodyInit` the vendored client refers to
  onto `Bun.BodyInit`. It keeps `lib: ["ESNext"]` free of the whole DOM surface and leaves the
  generated output unedited.
