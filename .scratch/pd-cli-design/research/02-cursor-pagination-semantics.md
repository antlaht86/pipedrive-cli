# Cursor pagination semantics in the Pipedrive v2 API

Research findings for ticket `.scratch/pd-cli-design/issues/02-research-cursor-pagination-semantics.md`.

Date of research: 2026-08-11.

## Sources used

Primary only. No live API calls were made.

| Short name | URL | Notes |
| --- | --- | --- |
| SPEC | `https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml` | Pipedrive OpenAPI v2 spec, `openapi: 3.0.1`, `info.version: 2.0.0`, server `https://api.pipedrive.com/api/v2`, 85 paths. Machine-read, not summarised. |
| PAG | `https://pipedrive.readme.io/docs/core-api-concepts-pagination` | Official "Pagination" concept page. Markdown source fetched from `https://pipedrive.readme.io/docs/core-api-concepts-pagination.md`, `updatedAt: 2025-11-12`. |
| MIG | `https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide` | Official v1 -> v2 migration guide. Markdown source from `.../pipedrive-api-v2-migration-guide.md`, `updatedAt: 2026-04-30`. |
| V2 | `https://pipedrive.readme.io/docs/pipedrive-api-v2` | Official v2 overview. |
| TUT | `https://developers.pipedrive.com/tutorials/pagination-pipedrive-api` | Official tutorial. Contains a v1-shaped example — see the warning below. |

`pipedrive.readme.io` is Pipedrive's own documentation site (the ReadMe-hosted content that `developers.pipedrive.com` links to). It is treated as primary here.

## 1. Request and response fields

### Request

Two query parameters, on every paginated v2 endpoint (SPEC — verified across all 40 endpoints that declare them; the parameter description string is byte-identical on all 40):

- `cursor` — `type: string`, no default. SPEC description: *"For pagination, the marker (an opaque string value) representing the first item on the next page"*.
- `limit` — `type: integer`, `example: 100`, **no `maximum` declared in the schema**. SPEC description: *"For pagination, the limit of entries to be returned. If not provided, 100 items will be returned. Please note that a maximum value of 500 is allowed."*

PAG states the same: *"Cursor-based endpoints accept the `cursor` and `limit` query parameters. A `cursor` is a marker indicating the next page's first item. By specifying the `limit`, you can control the number of entities returned per page. The maximum `limit` value is 500."*

The first page is requested by **omitting** `cursor` entirely. Neither SPEC nor PAG documents a sentinel value for "start from the beginning".

### Response

The next cursor lives at **`additional_data.next_cursor`** — top level of the response body, a sibling of `data`, *not* nested inside a `pagination` object (SPEC, verified on 39 endpoints).

PAG example response, verbatim:

```json
{
    "success": true,
    "data": [
        {
           … // returned activities’ data
        }
    ],
    "additional_data": {
        "next_cursor": "eyJhY3Rpdml0aWVzIjoyN30"
    }
}
```

### End-of-data signal

`next_cursor` is `null`. SPEC field description (33 endpoints): *"The first item on the next page. The value of the `next_cursor` field will be `null` if you have reached the end of the dataset and there's no more pages to be returned."* PAG says the same in prose.

Six endpoints — `/activityFields`, `/dealFields`, `/personFields`, `/organizationFields`, `/productFields`, `/projectFields` — carry a differently worded but semantically identical description, and are the only ones that also declare `nullable: true` on the field (SPEC): *"Base64url-encoded cursor for fetching the next page of results, null if no more pages"*.

**Practical consequence for `pd`**: the loop terminates on `next_cursor == null`. Because 33 of the 39 schemas declare `next_cursor` as a plain non-nullable `string`, the generated client's types will be wrong at end-of-data. The zod boundary schema must accept `string | null | undefined` regardless of what the generated types say. An empty `data` array is not a documented terminator and must not be used as one.

> **Warning — do not follow TUT.** The tutorial at `https://developers.pipedrive.com/tutorials/pagination-pipedrive-api` reads the cursor from `additional_data.pagination.next_cursor` and loops on `more_items_in_collection === true`. Neither field exists in any v2 response (SPEC: no v2 GET response declares `pagination` or `more_items_in_collection`). Those are the **offset**-pagination fields, documented in PAG's "Offset pagination" section for v1. The tutorial is stale with respect to v2.

## 2. The `limit` maximum

**500 on every v2 paginated endpoint except one.**

- 500: all 39 other paginated endpoints (SPEC parameter description; PAG: *"The maximum `limit` value is 500."*).
- **100: `GET /itemSearch`** — SPEC, uniquely: *"Please note that a maximum value of 100 is allowed."* This is the only endpoint in the whole v2 spec with a different cap.

Note that `/itemSearch/field` and the per-entity search endpoints (`/deals/search`, `/persons/search`, `/organizations/search`, `/products/search`, `/leads/search`, `/projects/search`) all declare **500**, not 100. Only the cross-entity `/itemSearch` is capped at 100.

The cap is **not machine-readable**: no `maximum` appears in any `limit` schema (SPEC). A client cannot derive it from the generated types and must hard-code it. SPEC also declares no `minimum`, and the behaviour of `limit` above the cap (clamp vs. 400) is not documented anywhere.

## 3. Which v2 endpoints paginate, and how

Every v2 collection endpoint that paginates uses **cursor** pagination. `start` / `next_start` / `more_items_in_collection` appear **nowhere** in the v2 spec (SPEC — parameter-name census over all 85 paths yields `limit` 40, `cursor` 40, and no `start`). MIG confirms: *"Offset based pagination (`start` & `limit`) has been replaced with cursor based pagination (`cursor` & `limit`), which makes iterating over large collections significantly faster."* V2 and PAG both scope this to *"All v2 API list endpoints"*.

### The 40 cursor-paginated v2 endpoints (SPEC)

`/activities`, `/activityFields`, `/deals`, `/deals/archived`, `/deals/{id}/followers`, `/deals/{id}/followers/changelog`, `/deals/products`, `/deals/{id}/products`, `/deals/search`, `/deals/installments`, `/dealFields`, `/persons`, `/persons/{id}/followers`, `/persons/{id}/followers/changelog`, `/persons/search`, `/personFields`, `/organizations`, `/organizations/{id}/followers`, `/organizations/{id}/followers/changelog`, `/organizations/search`, `/organizationFields`, `/products`, `/products/{id}/followers`, `/products/{id}/followers/changelog`, `/products/{id}/variations`, `/products/search`, `/productFields`, `/leads/search`, `/itemSearch`, `/itemSearch/field`, `/stages`, `/pipelines`, `/projects`, `/projects/archived`, `/projects/search`, `/projects/{id}/changelog`, `/projectFields`, `/projectTemplates`, `/tasks`, `/users/{id}/followers`.

### Collection endpoints that do NOT paginate at all (SPEC)

These declare neither `cursor` nor `limit` and return `additional_data: null` or nothing:

- `/boards` and `/phases` (project boards and phases) — `additional_data` is `{"nullable": true, "type": "object"}` and no pagination parameters exist. Small fixed collections; the whole set arrives in one response.
- `/deals/{id}/discounts`, `/products/{id}/images`, `/projects/{id}/permittedUsers` — sub-collections returning `success` + `data` with no `additional_data`.

`pd` must not attempt a cursor loop on these, and must not treat the absence of `next_cursor` there as an anomaly.

### Spec inconsistency: `/deals/installments`

`GET /deals/installments` **declares `cursor`, `limit`, `sort_by` and `sort_direction` as query parameters, but its 200 response schema (`GetInstallmentsResponse`) declares no `additional_data` at all** — only `success` and `data` (SPEC). Either the response schema is incomplete or the parameters are inert. This cannot be resolved from documentation and needs a live probe. Treat `/deals/installments` as untrusted for automatic pagination until verified.

### Resources with no v2 equivalent (offset pagination, v1 only)

The v2 spec covers 24 tag groups: Activities, ActivityFields, Deals, DealProducts, DealInstallments, DealFields, Products, ProductFields, Leads, Organizations, OrganizationFields, Persons, PersonFields, ItemSearch, Stages, Pipelines, Users, Projects, ProjectBoards, ProjectPhases, ProjectTemplates, ProjectFields, Tasks, Beta (SPEC `tags`).

Notably **absent from v2 entirely**: Notes, Files, Filters, Goals, Subscriptions, Mailbox, Roles, Teams, Currencies, Recents, Webhooks, LeadLabels, LeadSources, and a full `GET /users` list. The `Leads` tag in v2 is misleading — the only v2 lead paths are `/leads/search` and the two conversion-status paths. **There is no `GET /api/v2/leads` list endpoint.** Listing leads, notes or files requires v1, which means offset pagination (`start` / `limit` / `more_items_in_collection` / `next_start`, max limit 500 — PAG "Offset pagination").

`pd`'s pagination layer therefore needs **two** strategies, not one, if it covers any v1-only resource. PAG also lists a set of v1 endpoints that use cursor pagination (`/v1/activities/collection`, `/v1/deals/collection`, `/v1/organizations/collection`, `/v1/persons/collection`, the `changelog` endpoints, `/v1/projects*`, `/v1/projectTemplates`, `/v1/tasks`) — so v1 is a mix, and the strategy must be chosen per endpoint rather than per API version.

## 4. Cursor lifetime and stability — **not documented**

This is the headline finding, and it is a negative one.

**Nothing in any Pipedrive primary source states a cursor TTL, an expiry, an invalidation condition, a snapshot guarantee, or the behaviour of a walk when records are created, modified or deleted mid-walk.**

Evidence for the silence:

- PAG, the canonical pagination page, was fetched in full as Markdown. Its complete cursor section is reproduced above in section 1. It contains no sentence about expiry, staleness, invalidation, snapshots, or concurrent modification. The full HTML page was also fetched and searched: the three occurrences of the substring `expir` are all ReadMe platform boilerplate (`jwtExpirationTime`, `jwt_expiration_time`, a trial `expired` flag); `snapshot` and `stale` occur zero times.
- MIG's entire `### Pagination` section is one sentence (quoted in section 3). It says nothing about semantics.
- SPEC's `cursor` parameter description is a single line — *"the marker (an opaque string value) representing the first item on the next page"* — with no `format`, no expiry note, and no vendor extension carrying one. No SPEC response declares a cursor-expiry error, and no endpoint documents a distinct 4xx for an invalid or expired cursor.

The only positive claim Pipedrive makes about stability is a performance blurb, not a contract. PAG, verbatim: *"Performance-wise, it is the most efficient and stable pagination method for traversing through large amounts of entities."* The word "stable" here qualifies "pagination method" in a performance sentence. **It is not a snapshot-isolation guarantee and must not be read as one.**

### Circumstantial evidence: the cursors are keyset markers, not snapshot handles

Pipedrive calls the cursor "an opaque string value" (SPEC, PAG), but the two example cursors published in PAG decode cleanly as base64url:

| Cursor from PAG | base64url-decoded |
| --- | --- |
| `eyJhY3Rpdml0eSI6NDJ9` | `{"activity":42}` |
| `eyJhY3Rpdml0aWVzIjoyN30` | `{"activities":27}` |

The `*Fields` endpoints' own SPEC description independently confirms the encoding: *"Base64url-encoded cursor for fetching the next page of results"*.

A cursor that carries only an entity name and an id is a **keyset marker** — "resume after id N in the current sort order" — not a handle to a server-side snapshot or a materialised result set. If that is what it is in production, the expected consequences of a long walk are:

- **No expiry.** There is no server-side state to time out. A cursor should stay usable indefinitely, which would make a resumable partial walk feasible.
- **No snapshot.** Each page is a fresh query. Records created mid-walk with an id greater than the cursor position **will** appear; records deleted mid-walk **will** vanish.
- **Under the default `sort_by=id`, insert-safety is good**: new records get higher ids and land ahead of the cursor, so nothing already-walked is re-emitted and nothing is skipped. This is the ordinary keyset-pagination property.
- **Under `sort_by=update_time`, it is not.** A record edited mid-walk moves in the sort order. Records can be both duplicated and skipped. The same hazard applies to any mutable sort key (`add_time` is effectively immutable; `update_time`, `name`, `order_nr`, `due_date`, `billing_date` are not).

**Treat all of the above as inference, not documented fact.** The decoding is real and comes from Pipedrive's own published examples, but the cursor is officially opaque, its format can change without notice, and `pd` must never parse, construct or reason about cursor contents at runtime. This inference is only good enough to guide a design bet, and it needs a live probe before anything depends on it. See "Open questions" below.

## 5. Sort order

### Where sorting is controllable

Only **11 of the 40** paginated v2 endpoints accept sorting parameters (SPEC). Both parameters are optional, and MIG states *"A maximum of 1 field to sort by can be provided."*

- `sort_by` — enum, **`default: id`** in every case.
- `sort_direction` — enum `[asc, desc]`, **`default: asc`** in every case.

| Endpoints | `sort_by` enum |
| --- | --- |
| `/deals`, `/deals/archived`, `/persons`, `/organizations`, `/pipelines` | `id`, `update_time`, `add_time` |
| `/activities` | `id`, `update_time`, `add_time`, `due_date` |
| `/products` | `id`, `name`, `add_time`, `update_time` |
| `/stages` | `id`, `update_time`, `add_time`, `order_nr` |
| `/deals/{id}/products` | `id`, `add_time`, `update_time`, `order_nr` |
| `/deals/products` | `id`, `deal_id`, `add_time`, `update_time`, `order_nr` |
| `/deals/installments` | `id`, `billing_date`, `deal_id` |

MIG corroborates the shape: *"Endpoints, which support sorting, now have 2 optional parameters (`sort_by` and `sort_direction`) instead of 1 (`sort`)"*, with *"`sort_by` accepted values: `id`, `add_time`, `update_time` plus a few additional fields depending on the entity. Defaults to `id`."*

### Where sorting is NOT controllable

The remaining 29 paginated endpoints — including **every search endpoint**, every `*Fields` endpoint, every `followers` and `changelog` endpoint, `/projects`, `/projects/archived`, `/projectTemplates` and `/tasks` — expose no sort parameters at all (SPEC). **Their ordering is entirely undocumented.** Search endpoints return a `result_score` per item (SPEC: *"Search result relevancy"*), which suggests relevance ordering, but no source states this and no source guarantees it is deterministic across requests.

### Is the order guaranteed?

**Not in writing.** No source states that the sort is total, stable, or deterministic for ties. Since the documented default is `sort_by=id` and ids are unique, the default ordering has no ties and is total in practice — but this is derived from the enum default, not from a stated guarantee. There is no documented tie-breaker for `sort_by=update_time`, `name` or `order_nr`, where ties are entirely possible.

**Practical consequence for `pd`**: `sort_by=id&sort_direction=asc` is the only ordering with a plausible correctness argument for a long walk, and it is already the default on all 11 endpoints. `pd` should pin it explicitly rather than rely on the default, and should not expose `update_time` sorting on a paginated walk without documenting the duplicate/skip hazard. Where no sort parameter exists, `pd` cannot promise a stable order at all.

## 6. Total count — **does not exist in v2**

There is **no** total count, result count, page count, or "more items" boolean anywhere in the v2 API.

- SPEC: no v2 GET response declares `total`, `total_count`, `count`, `more_items_in_collection` or `next_start`. `additional_data` contains `next_cursor` and nothing else on every paginated endpoint.
- SPEC parameter census over all 85 paths: no `get_summary`, `include_counts` or equivalent parameter exists.
- MIG confirms the removal explicitly for products: *"`get_summary` and `first_char` parameters have been removed"*.

So the question "does obtaining a total cost an extra request?" does not arise — **it is not obtainable at any price from v2**. The only way to know how many deals exist is to walk them all.

**Practical consequences for `pd`**:

- Progress on a long pagination run cannot be reported as a percentage or an ETA. Only "N items so far, page P" is possible. This constrains the still-open "Structured logging on stderr" decision in `map.md`.
- `--max-requests` cannot be pre-validated against a known dataset size. The budget guard can only count requests as it makes them and abort, never predict.
- A "how many deals do we have?" question from an agent is a full walk with a full token cost. That is worth surfacing in `AGENTS.md`, because an agent will otherwise ask it casually.
- v1 offset pagination *does* expose `more_items_in_collection` (PAG), but still no total.

## 7. Incremental-walk parameters (relevant to resumability)

Not asked in the ticket, but it bears directly on the resumability question, so it is recorded here.

Six v2 endpoints accept `updated_since`, and five of those also accept `updated_until` (SPEC), all `type: string` in RFC3339, e.g. `2025-01-01T10:20:00Z`:

| Endpoint | `updated_since` | `updated_until` |
| --- | --- | --- |
| `/activities` | yes | yes |
| `/deals` | yes | yes |
| `/deals/archived` | yes | yes |
| `/persons` | yes | yes |
| `/organizations` | yes | yes |
| `/products` | yes | **no** |

SPEC descriptions are consistent: `updated_since` is *"later than or equal to this time"* (inclusive), `updated_until` is *"earlier than this time"* (exclusive). The half-open interval means consecutive windows tile without overlap or gap.

This gives a **second, cheaper resumption mechanism that does not depend on cursor semantics at all**: cache a high-water mark of `update_time` and re-walk only what changed. It is available on exactly the five or six entities that matter most and nowhere else. If the cursor-stability question cannot be resolved, an `updated_since` high-water mark is the fallback that carries no undocumented risk.

## Open questions / not documented

Ordered by how much a `pd` design decision hangs on the answer.

1. **Does a cursor expire? — NOT DOCUMENTED.** No TTL, no invalidation condition, no error code for a stale cursor appears in SPEC, PAG, MIG or V2. The silence is the finding. Any design that persists a cursor across process boundaries (resume a stopped run tomorrow) is building on an undocumented behaviour. **The decision on resumable partial results must either treat cursor persistence as unsupported, or accept an explicit, documented risk, or be settled by a live probe.**
2. **What happens to a walk when records are created, modified or deleted mid-walk? — NOT DOCUMENTED.** Neither skip-freedom nor duplicate-freedom is promised. The keyset inference in section 4 predicts safety under `sort_by=id` and hazard under `sort_by=update_time`, but this is inference from two decoded example strings, not a contract.
3. **Is the cursor format stable across API releases?** Officially "opaque" (SPEC, PAG), which is Pipedrive reserving the right to change it. A persisted cursor could therefore become unreadable after a Pipedrive-side deploy, independently of any TTL.
4. **What error does an invalid, malformed or stale cursor produce?** No SPEC response declares one. Unknown whether it is 400, 410, an empty page, or a silent restart from the beginning. `pd`'s error union needs a case for this and cannot name its trigger conditions from documentation.
5. **Is `limit` above the cap clamped to 500, or rejected with 400?** Not documented, and not expressible in SPEC since no `maximum` is declared. `pd` should clamp client-side and never find out.
6. **Does `/deals/installments` actually paginate?** It declares `cursor`, `limit` and sorting, but its response schema has no `additional_data` (SPEC). A spec bug in one direction or the other. Needs a live probe.
7. **What order do the 29 unsorted paginated endpoints return?** Undocumented, including all search endpoints and all `*Fields` endpoints. Whether that order is even stable between two identical requests is unknown.
8. **Is the sort total, and what breaks ties?** No documented tie-breaker for `update_time`, `name`, `order_nr`, `due_date` or `billing_date`. Only `id` is inherently unique.
9. **Is there a sentinel `cursor` value meaning "first page"?** Only omission is documented.
10. **Does the daily token cost of a request depend on `limit`?** Out of scope here — see ticket 01 on rate limits — but it decides whether `limit=500` is the correct default for `pd` or merely the fastest one. The two tickets must agree on this before the pagination default is locked.

### Suggested live probes

All of 1, 2, 4 and 6 are cheap to settle empirically and expensive to guess wrong. A single prototype run against a small collection would answer them at a cost of a handful of requests:

- Fetch page 1 with `limit=2`, wait, then reuse the same cursor after a delay and again on a later day — settles expiry (1).
- Reuse a page-1 cursor twice and diff the results — settles determinism (2).
- Send a corrupted cursor and record the status code and body — settles (4).
- One `GET /deals/installments?limit=1` and inspect `additional_data` — settles (6).

Note the constraint from `map.md`: the daily API budget is token-based and shared across the whole company account. These probes are small, but they must be run deliberately as one batch, not incidentally.
