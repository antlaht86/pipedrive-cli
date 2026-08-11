# Research: v1 / v2 resource coverage and what a generated-v2 client misses

Ticket: `issues/04-research-v1-v2-resource-coverage.md`
Date of investigation: 2026-08-11
Method: both OpenAPI specs downloaded and parsed mechanically (every `get` operation enumerated), plus Pipedrive's own changelog and migration guide. No live API calls were made.

## Primary sources

| What | URL |
| --- | --- |
| v2 OpenAPI spec (`Pipedrive API v2`, 2.0.0, ~1.0 MB) | https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml |
| v1 OpenAPI spec (`Pipedrive API v1`, 1.0.0, ~1.8 MB) | https://developers.pipedrive.com/docs/api/v1/openapi.yaml |
| Deprecation announcement (14 Apr 2025) | https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints |
| "Out of support" announcement (29 Jul 2026) | https://developers.pipedrive.com/changelog/post/deprecated-apiv1-endpoints-become-out-of-support |
| API v2 overview | https://pipedrive.readme.io/docs/pipedrive-api-v2 |
| v1 → v2 migration guide | https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide |
| Changelog index | https://developers.pipedrive.com/changelog |

Counts from the specs themselves: **v1 exposes 114 GET operations, v2 exposes 66.**
(Source: enumeration of `paths.*.get` in both spec URLs above.)

---

## Headline finding: the ticket's premise about field-schema endpoints is wrong

The ticket asks "specifically whether the field-schema endpoints from the custom field ticket are among" the v1-only set. **They are not.** The field-schema endpoints are fully present in v2:

| Operation | v2 path | v1 path |
| --- | --- | --- |
| `getDealFields` / `getDealField` | `/dealFields`, `/dealFields/{field_code}` | `/dealFields`, `/dealFields/{id}` |
| `getPersonFields` / `getPersonField` | `/personFields`, `/personFields/{field_code}` | `/personFields`, `/personFields/{id}` |
| `getOrganizationFields` / `getOrganizationField` | `/organizationFields`, `/organizationFields/{field_code}` | same shape |
| `getProductFields` / `getProductField` | `/productFields`, `/productFields/{field_code}` | same shape |
| `getActivityFields` | `/activityFields`, `/activityFields/{field_code}` | `/activityFields` (list only) |
| `getProjectFields` (Beta) | `/projectFields`, `/projectFields/{field_code}` | — (not in v1) |

Source: both spec URLs above. The v2 overview confirms in prose: "Fields API (ActivityFields, DealFields, OrganizationFields, PersonFields, ProductFields)" is listed among v2's available APIs — https://pipedrive.readme.io/docs/pipedrive-api-v2

**Two consequences for the design:**

1. Custom-field resolution (locked decision 6 in `map.md`) needs **no v1 fallback** for deals, persons, organizations, products or activities. That path is entirely inside the generated v2 client.
2. The single-field path parameter renamed from `{id}` to `{field_code}` in v2. The generated client's argument name changes accordingly.

**Stragglers that stayed behind:** `leadFields` (`GET /leadFields`) and `noteFields` (`GET /noteFields`) exist **only in v1** — there is no v2 equivalent. Source: https://developers.pipedrive.com/docs/api/v1/openapi.yaml (present) vs https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml (absent).

---

## The deprecation taxonomy: three classes, not two

This distinction is the core design input, so it is worth stating precisely.

### Class A — v1 endpoints that HAVE a v2 equivalent: deprecated, sunset, out of support

- **Deprecated:** announced 14 Apr 2025, effective 1 Jan 2026. "Deprecated endpoints will remain accessible until December 31, 2025. After this date, their availability and functionality will no longer be guaranteed." — https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints
- **Out of support:** effective 1 Aug 2026, announced 29 Jul 2026. Pipedrive's wording is deliberately not "removed": "Although these endpoints may remain functional, Pipedrive no longer provides technical support, maintenance, bug fixes, or service-level guarantees for them." Pipedrive "does not guarantee their availability, reliability, performance, or response behavior," issues "may not be investigated or resolved," and only v2 endpoints receive "fixes and improvements." — https://developers.pipedrive.com/changelog/post/deprecated-apiv1-endpoints-become-out-of-support

Covered categories: Activities, Deals, Persons, Organizations, Products, Pipelines, Stages, Search (itemSearch). Selected mappings (full table at the changelog URL):

| Deprecated v1 | v2 replacement |
| --- | --- |
| `GET /v1/deals`, `GET /v1/deals/collection`, `GET /v1/deals/{id}` | `GET /api/v2/deals`, `GET /api/v2/deals/{id}` |
| `GET /v1/deals/{id}/activities` | `GET /api/v2/activities?deal_id={id}` |
| `GET /v1/deals/{id}/persons` | `GET /api/v2/persons?deal_id={id}` |
| `GET /v1/persons`, `/v1/persons/{id}`, `/v1/persons/search` | `GET /api/v2/persons`, `/persons/{id}`, `/persons/search` |
| `GET /v1/persons/{id}/deals` | `GET /api/v2/deals?person_id={id}` |
| `GET /v1/organizations/{id}/persons` | `GET /api/v2/persons?org_id={id}` |
| `GET /v1/itemSearch`, `/v1/itemSearch/field` | `GET /api/v2/itemSearch`, `/itemSearch/field` |

Source for the whole table: https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints

**Corroborating evidence from the spec itself:** these deprecated operations have been *deleted from the published v1 spec*. `GET /deals`, `GET /deals/{id}`, `GET /persons`, `GET /organizations`, `GET /activities`, `GET /pipelines`, `GET /stages`, `GET /itemSearch` no longer appear in https://developers.pipedrive.com/docs/api/v1/openapi.yaml. A generated v1 client therefore cannot even reach them. That is a documentation removal, not a proven server-side removal — see Open questions.

### Class B — v1-only endpoints with NO v2 equivalent: not deprecated, still the supported path

These appear in **neither** deprecation post. They are the only way to read these resources and remain supported. This class is what actually matters for the design.

| Resource | v1 GET operations (no v2 equivalent) |
| --- | --- |
| **Leads (list/read)** | `/leads`, `/leads/{id}`, `/leads/archived`, `/leads/{id}/permittedUsers` |
| **Lead metadata** | `/leadFields`, `/leadLabels`, `/leadSources` |
| **Notes** | `/notes`, `/notes/{id}`, `/notes/{id}/comments`, `/notes/{id}/comments/{commentId}`, `/noteFields` |
| **Users** | `/users`, `/users/me`, `/users/{id}`, `/users/find`, `/users/{id}/permissions`, `/users/{id}/roleAssignments`, `/users/{id}/roleSettings`, `/userSettings`, `/userConnections` |
| **Currencies** | `/currencies` |
| **Activity types** | `/activityTypes` |
| **Filters** | `/filters`, `/filters/{id}`, `/filters/helpers` |
| **Files** | `/files`, `/files/{id}`, `/files/{id}/download` |
| **Audit / history** | `/deals/{id}/changelog`, `/deals/{id}/flow`, `/persons/{id}/changelog`, `/persons/{id}/flow`, `/organizations/{id}/changelog`, `/organizations/{id}/flow` |
| **Deal extras** | `/deals/summary`, `/deals/timeline`, `/deals/{id}/participants`, `/deals/{id}/mailMessages`, `/deals/{id}/files`, `/deals/{id}/permittedUsers` |
| **Pipeline analytics** | `/pipelines/{id}/conversion_statistics`, `/pipelines/{id}/movement_statistics`, `/pipelines/{id}/deals`, `/stages/{id}/deals` |
| **Org relationships** | `/organizationRelationships`, `/organizationRelationships/{id}` |
| **Permissions** | `/roles*`, `/permissionSets*`, `/legacyTeams*` |
| **Other** | `/goals/find`, `/goals/{id}/results`, `/recents`, `/callLogs`, `/mailbox/*`, `/billing/subscriptions/addons`, `/webhooks` |

Source: enumeration of https://developers.pipedrive.com/docs/api/v1/openapi.yaml minus https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml

**The single biggest read gap is Leads.** v2 carries only `GET /leads/search` and `GET /leads/{id}/convert/status/{conversion_id}` — there is no v2 list or read-by-id for leads. A read-only CRM tool that wants "list all leads" must call v1. Source: both spec URLs.

For a read-only CRM tool aimed at an agent, the Class B items most likely to be wanted are, in rough order: **Leads list/get, Notes, Users (to resolve `owner_id` to a name), Currencies (to format money), ActivityTypes, Filters, and the `leadLabels`/`leadSources` label tables.**

### Class C — v2-only, no v1 equivalent

`/deals/installments`, `/deals/products` (cross-deal), `/deals/{id}/discounts`, `/deals/{id}/followers/changelog` (and the person/org/product/user follower-changelog siblings), `/persons/{id}/picture`, `/products/{id}/images`, `/projects/search` (Beta), `/projects/{id}/permittedUsers`, `/projectFields`. Projects and Tasks exist in both but were re-released as v2 on 21 May 2026 — https://developers.pipedrive.com/changelog/post/introducing-projects-api-v2

---

## v1 vs v2 differences that affect the client module

### Base URL — different, and v2 is strict

- v1 server: `https://api.pipedrive.com/v1` (spec `servers[0].url`)
- v2 server: `https://api.pipedrive.com/api/v2` (spec `servers[0].url`)
- Migration guide, verbatim: "Only `/api/v2/...` prefix is supported. Previously both `/api/v1/...` and `/v1/...` could be used." — https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide

Note the asymmetry: v1 is `/v1`, v2 is `/api/v2`. Two different base URLs, not a swappable version segment.

### Authentication — identical

Both specs declare the same three `components.securitySchemes`, byte-for-byte equivalent:

- `api_key`: `apiKey` in header, name `x-api-token`
- `basic_authentication`: HTTP basic, `Basic <base64(client_id:client_secret)>`
- `oauth2`: authorization-code flow, `https://oauth.pipedrive.com/oauth/authorize` / `.../token`, same scope list (`base`, `deals:read`, `deals:full`, …)

Source: `components.securitySchemes` in both spec URLs. **An API token works unchanged across both versions.** Neither spec sets a global `security:` block, so the requirement is documented per-scheme only.

### Pagination — genuinely different

Migration guide, verbatim: "Offset based pagination (`start` & `limit`) has been replaced with cursor based pagination (`cursor` & `limit`)." — https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide

Confirmed in the specs:

| | v1 | v2 |
| --- | --- | --- |
| Request params | `start` (integer, default 0), `limit` | `cursor` (opaque string), `limit` |
| Response envelope | `additional_data.pagination { start, limit, more_items_in_collection, next_start }` — or, on some endpoints, those four fields directly under `additional_data` with **no `pagination` wrapper** | `additional_data.next_cursor` (string, nullable; null means end of data) |
| `limit` max | **mostly unstated in the spec.** `/files` says "a maximum value of 100 is allowed". Most others say only "Items shown per page" | "If not provided, 100 items will be returned. Please note that a maximum value of 500 is allowed." Stated uniformly |

Source: parameter and response schemas in both spec URLs.

Two traps here:

1. **The v1 envelope is not uniform.** `GET /notes` nests pagination as `additional_data.pagination.{start,limit,more_items_in_collection,next_start}`. `GET /leads` and `GET /dealFields` put `{start, limit, more_items_in_collection}` directly on `additional_data` with **no `next_start` at all** — the caller must compute the next offset itself. Any v1 pagination helper must handle both shapes.
2. **Some v1 endpoints are not paginated at all.** `GET /users`, `GET /activityTypes` declare zero parameters; `GET /currencies` takes only `term`. They return the full collection in one response.

The v2 `limit` max of 500 matches locked decision 5 and the `map.md` note. There is **no primary source for a v1 `limit` maximum** beyond `/files` = 100 — see Open questions and cross-reference research-02.

### Custom fields — different representation

Migration guide, verbatim: "Entity custom fields have been moved to a separate `custom_fields` object with clearer syntax." v1 scattered them at the root as `"field_id": value` alongside `"field_id_currency": "EUR"`; v2 nests them as `"custom_fields": { "field_id": { "value": X, "currency": "EUR" } }`. — https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide

v2 additionally exposes request params v1 lacks: `custom_fields`, `include_option_labels`, `include_labels`, `include_fields` on `GET /deals`. Notably **`include_option_labels`** — worth checking against research-03, since it may resolve enum/set option ids server-side and remove a whole class of client-side lookup. Source: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml

### Rate limiting and token cost — v2 is half the price

Changelog, verbatim: v2 endpoints "offer improved performance and consume 50% fewer tokens under our Token-Based Rate Limiting system." — https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints

The v2 overview repeats this as "lower rate limiter token costs per endpoint" — https://pipedrive.readme.io/docs/pipedrive-api-v2

**Design consequence:** given the shared company-wide daily token budget called out in `map.md`, this is a budget argument, not only a modernity argument. Any request routed to v1 costs roughly twice a v2 request. Combined with the v1 `limit` ceiling being unstated (and 100 where it is stated, versus 500 in v2), a full v1 pagination run can cost substantially more than the v2 equivalent for the same data. Defer to research-01 for the actual token table.

### Error shapes — NOT derivable from either spec

This is a negative finding worth recording plainly.

- **v2**: across all 66 GET operations, the specs document only `200` (66 times) and `404` (twice). No `400`, `401`, `403`, `429` or `5xx` response schema anywhere.
- **v1**: across all 114 GET operations, only `200` (114), `404` (7), `401` (4), `403` (1), `410` (1).

Source: enumeration of `paths.*.get.responses` in both spec URLs.

Consequently a client generated by `@hey-api/openapi-ts` will have **no typed error model at all**, and the runtime 4xx/429 envelope cannot be established from the specs. It must be hand-modelled at the client-module boundary with `zod` and mapped into the `neverthrow` error union — which is consistent with locked decision 7. Do not infer the envelope from memory; see Open questions.

### Spec quality for `@hey-api/openapi-ts`

| | v1 spec | v2 spec |
| --- | --- | --- |
| OpenAPI version | 3.0.1 | 3.0.1 |
| Size | ~1.78 MB | ~1.02 MB |
| `components` keys | `securitySchemes` **only** | `schemas` **and** `securitySchemes` |

Source: parsed from both spec URLs.

The v1 spec has **no `components.schemas` section** — every request and response schema is written inline at its operation. It is valid OpenAPI 3.0.1 and generation should succeed, but the output will be a large set of inline, per-operation, structurally duplicated types with no shared named models (no reusable `Note`, `User`, `Lead` type). The v2 spec has proper shared schemas. So: a v1 client is generatable, but its generated types are markedly lower quality than v2's, and the two clients cannot share model types.

---

## Bottom line for the design decision

1. The generated-v2 client covers **more than the ticket assumed** — critically, all the custom-field schema endpoints. The custom-field resolution feature needs no v1 at all.
2. The real v1-only gap for a read-only CRM tool is **Leads (list/get), Notes, Users, Currencies, ActivityTypes, Filters, leadFields/noteFields, and entity changelog/flow history** — Class B, none of it deprecated, all of it the supported path.
3. Reaching Class B means a **second generated client** (different base URL, different pagination model, different response envelope, lower-quality generated types) or hand-written calls. Same auth token either way.
4. Class A v1 endpoints (deals/persons/orgs/…) should **never** be called: out of support since 1 Aug 2026, absent from the published v1 spec, and twice the token cost. There is no legitimate reason for `pd` to touch them.

---

## Open questions / not documented

- **Are Class A v1 endpoints actually still serving traffic?** Pipedrive's wording is "may remain functional… no guarantees," and they have been stripped from the published v1 spec, but no post announces removal or a date for it. Not verifiable without a live call, which the ticket forbids. Treat as unavailable regardless.
- **The runtime error envelope for 4xx/429 in both versions.** Absent from both specs (see above). Needs a documentation source or a recorded fixture; cross-reference research-01, which covers rate limiting and should have seen `429` bodies and any `Retry-After` / `x-ratelimit-*` headers.
- **The v1 `limit` maximum for endpoints other than `/files`.** The spec states 100 only for `/files` and is silent elsewhere. No primary source found for a general v1 maximum. Cross-reference research-02.
- **Exact token cost per endpoint.** Only the relative "50% fewer" claim was found in the changelog. The absolute per-endpoint table lives in the rate-limiting docs — research-01's territory.
- **When the field-schema endpoints landed in v2.** No dated changelog post for a "Fields API v2" release was found in the changelog index. They are present in the current spec and listed in the v2 overview; the release date is undated for our purposes.
- **Whether `include_option_labels` on v2 list endpoints fully resolves enum/set option ids**, and what it costs. The parameter exists in the v2 spec but its semantics were not chased here. Directly relevant to research-03 and to locked decision 6.
- **Whether v1 and v2 share one rate-limit budget or account separately.** Not stated in any source found. The token-based budget is described as account-wide, which implies shared, but this is inference, not a cited fact.
- **`GET /leads` cursor support.** The v1 spec shows `start`/`limit` only. Whether Pipedrive has quietly added cursor support to v1 Leads is not documented.
