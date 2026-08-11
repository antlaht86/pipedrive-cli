# Pipedrive rate limiting and the shared daily token budget

Research findings for `.scratch/pd-cli-design/issues/01-research-rate-limits-and-token-budget.md`.
Researched 2026-08-11. Primary sources only: Pipedrive's own developer documentation and Pipedrive's own published OpenAPI specifications. No live API calls were made.

## Sources used

| Short name | URL |
| --- | --- |
| Rate limiting page | https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting.md |
| Optimizing guide | https://pipedrive.readme.io/docs/guide-for-optimizing-api-usage.md |
| HTTP status codes | https://pipedrive.readme.io/docs/core-api-concepts-http-status-codes.md |
| Pagination | https://pipedrive.readme.io/docs/core-api-concepts-pagination.md |
| API v2 overview | https://pipedrive.readme.io/docs/pipedrive-api-v2.md |
| OpenAPI v2 spec | https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml |
| OpenAPI v1 spec | https://developers.pipedrive.com/docs/api/v1/openapi.yaml |
| Changelog: token-based limits | https://developers.pipedrive.com/changelog/post/breaking-changes-token-based-rate-limits-for-api-requests |
| Changelog: per-token window (2018) | https://developers.pipedrive.com/changelog/post/new-rate-limits-window |
| Changelog: v2 stable | https://developers.pipedrive.com/changelog/post/apiv2-endpoints-now-stable-improved-performance-lower-token-costs |

The `.md` variants come from Pipedrive's own documentation index at https://pipedrive.readme.io/llms.txt, which the rate limiting page itself advertises: "For AI agents: visit https://pipedrive.readme.io/llms.txt for an index of all pages formatted in Markdown and endpoints in OpenAPI."

---

## Headline finding

**There is no documented response header that reports remaining daily token budget.**

All four documented headers are burst-window headers or a POST/PUT-only counter. A read-only GET tool gets no reactive signal about the daily token pool from any documented header. This directly contradicts the ticket's working assumption that "which response headers report remaining budget" has an answer. Budget accounting for `pd` must be client-side and predictive (cost table x request count), not header-driven.

See "Contradiction in Pipedrive's own docs" below — one Pipedrive page claims the headers do report token counts, and the header table says otherwise.

---

## 1. Daily token budget

**Formula, verbatim** (Rate limiting page):

> The daily token budget is calculated using the following formula:
>
> 30,000 base tokens × subscription plan multiplier × number of seats (+ purchased API Token top-ups)

**Plan multipliers, verbatim table** (Rate limiting page):

| Plan | Plan multiplier |
| --- | --- |
| Lite | 1 |
| Growth | 2 |
| Premium | 5 |
| Ultimate | 7 |

**Scope — shared, confirming the map's safety property** (Rate limiting page):

> Each company account is allocated a **daily API token budget**, which is shared among all users within that account. This budget is exclusively for API traffic authenticated by API tokens or OAuth tokens, and it does not impact actions performed directly within the Pipedrive user interface.

Restated in the Optimizing guide:

> Each Pipedrive account is allocated a specific daily token budget, calculated based on the number of seats and the pricing plan associated with the account. This budget is shared among all users within the account, meaning that each API request made by any user or integration will draw from the same pool of tokens

For OAuth Marketplace apps (Optimizing guide):

> For Marketplace applications using OAuth authentication, tokens are drawn from the end-user's account budget. Exceeding the token budget on one account will not impact other accounts using the same application.

**Reset time, verbatim** (Rate limiting page, stated twice):

> Tokens budget resets at midnight at server's timezone which may not be aligned with timezone of customer location.

The server timezone is **not named** anywhere in the documentation. Note that the `x-daily-requests-left` header — a different counter — is documented as "calculated in UTC", but the docs do not say the token budget resets in UTC.

**Rollout schedule, verbatim** (Rate limiting page):

> **New Customers:** Starting on **December 2nd, 2024**, all new signups will operate under the token-based rate limiting system from the outset.
>
> **Existing Customers:** For current accounts, rate limits will be gradually rolled out beginning **March 1st, 2025**, with the process scheduled to complete by **Dec 31st, 2025**.

As of the research date (2026-08-11) the rollout is therefore complete for all accounts.

---

## 2. Request cost

### Documented cost table (Rate limiting page)

> Costs for some of the API operations are listed below:

| API Endpoint type | Cost in tokens |
| --- | --- |
| Get single entity | 2 |
| Get list of entities | 20 |
| Update single entity | 10 |
| Delete single entity | 6 |
| Delete list of entities | 10 |
| Search for entities | 40 |

**Important:** these numbers match the **v1** costs in the OpenAPI spec, not v2. The doc page does not say so. Treating this table as authoritative for a v2 client would overestimate cost by 2x.

The page defers to the spec for exact numbers:

> You can view the token costs for each API endpoint in our API Reference.

and notes:

> Available API v2 endpoints are performance-optimized, resulting in lower token costs compared to the original v1 endpoints.

The Optimizing guide quantifies "lower":

> By switching to API v2, developers can achieve significantly faster response times and benefit from token costs that are **up to half the cost** of the original endpoints.

### Authoritative per-endpoint costs: the `x-token-cost` OpenAPI extension

Both of Pipedrive's published OpenAPI documents carry a vendor extension `x-token-cost` on every operation. This is the machine-readable source the docs point at, and it is a primary source.

Distribution across **GET** operations:

| Spec | GET operations | Cost distribution |
| --- | --- | --- |
| `openapi-v2.yaml` (v2) | 66 | 1 → 19 ops, 5 → 3 ops, 10 → 35 ops, 20 → 9 ops |
| `openapi.yaml` (v1) | 114 | 0 → 1 op, 2 → 24 ops, 10 → 13 ops, 20 → 64 ops, 40 → 11 ops, 80 → 1 op |

v2 GET costs relevant to `pd` (verbatim from `openapi-v2.yaml`):

| Cost | Operation |
| --- | --- |
| 10 | `GET /deals` |
| 1 | `GET /deals/{id}` |
| 20 | `GET /deals/archived` |
| 20 | `GET /deals/search` |
| 10 | `GET /deals/{id}/products` |
| 10 | `GET /deals/{id}/discounts` |
| 10 | `GET /deals/{id}/followers` |
| 10 | `GET /persons` |
| 1 | `GET /persons/{id}` |
| 20 | `GET /persons/search` |
| 10 | `GET /organizations` |
| 1 | `GET /organizations/{id}` |
| 20 | `GET /organizations/search` |
| 10 | `GET /activities` |
| 1 | `GET /activities/{id}` |
| 10 | `GET /products` |
| 1 | `GET /products/{id}` |
| 20 | `GET /products/search` |
| 5 | `GET /pipelines` |
| 1 | `GET /pipelines/{id}` |
| 5 | `GET /stages` |
| 1 | `GET /stages/{id}` |
| 10 | `GET /dealFields`, `/personFields`, `/organizationFields`, `/productFields`, `/activityFields`, `/projectFields` |
| 1 | `GET /dealFields/{field_code}` (and the other `*Fields/{field_code}`) |
| 20 | `GET /itemSearch` |
| 20 | `GET /itemSearch/field` |
| 20 | `GET /leads/search` |
| 10 | `GET /tasks`, `GET /projects`, `GET /boards`, `GET /phases` |

Selected v1-only GET costs (`openapi.yaml`), for resources v2 does not cover:

| Cost | Operation |
| --- | --- |
| 20 | `GET /leads` |
| 40 | `GET /leads/archived` |
| 40 | `GET /leads/search` |
| 2 | `GET /leads/{id}` |
| 20 | `GET /notes` |
| 2 | `GET /notes/{id}` |
| 20 | `GET /files` |
| 20 | `GET /filters` |
| 20 | `GET /users` |
| 2 | `GET /users/me` |
| 2 | `GET /users/{id}` |
| 20 | `GET /currencies` |
| 20 | `GET /activityTypes` |
| 20 | `GET /recents` |
| 40 | `GET /deals/summary` |
| 80 | `GET /deals/summary/archived` |
| 40 | `GET /deals/{id}/flow`, `/persons/{id}/flow`, `/organizations/{id}/flow` |
| 20 | `GET /deals/{id}/changelog`, `/persons/{id}/changelog`, `/organizations/{id}/changelog` |
| 20 | `GET /pipelines/{id}/deals`, `GET /stages/{id}/deals` |
| 20 | `GET /leadFields`, `GET /noteFields` |
| 10 | `GET /leadLabels` |
| 2 | `GET /leadSources` |
| 10 | `GET /webhooks` |

**The v2/v1 ratio is exactly 1/2 for the common shapes**: list 10 vs 20, single 1 vs 2, search 20 vs 40. This makes the map's locked decision to generate the client from the v2 spec worth a factor of two in budget, and makes each v1-only fallback measurably more expensive.

**Cost is flat per request in the spec.** `x-token-cost` is a single scalar per operation. Nothing in the specification or the documentation makes cost a function of the `limit` query parameter, the page size, the response byte count or the number of matched records. Fetching 500 deals in one `GET /deals` costs the same 10 tokens as fetching 1. Nothing states cost varies by anything except the operation itself.

**Consequence for pagination**: since cost is per request and `limit` max is 500, always paginating at `limit=500` minimises token spend by up to 5x versus the default 100. The pagination page states:

> The maximum `limit` value is 500.

and

> `limit (integer)` | For pagination, the limit of entries to be returned. If not provided, 100 items will be returned.

---

## 3. Burst limits

**Window and scope, verbatim** (Rate limiting page):

> Burst rate limits apply at the individual user level within each company account, operating on a rolling 2-second window. This means that each user has a maximum allowable number of requests within any 2-second timeframe, based on the company's subscription plan.

and, in a callout immediately above the limits table:

> Burst rate limiting of the Pipedrive API is considered **per token**, not per company.

These two sentences on the same page say different things ("per individual user" vs "per token"). A 2018 changelog — https://developers.pipedrive.com/changelog/post/new-rate-limits-window — is titled "New Rate Limits Window per `access_token` (or `api_token`)" and scopes the limits per token, which supports the per-token reading, but that post predates the token-budget system and names obsolete plan tiers (Silver/Gold/Platinum) and an additional 10-second window that current documentation does not mention. Treat the per-token reading as the practical one and the "per user" phrasing as loose, but this is not unambiguously documented.

For `pd`, per-token and per-user coincide anyway: one API token belonging to one user.

**Burst limits table, verbatim** (Rate limiting page):

| Plan | API token limits | OAuth apps limits |
| --- | --- | --- |
| Lite | 20 requests per 2 seconds | 80 requests per 2 seconds |
| Growth | 40 requests per 2 seconds | 160 requests per 2 seconds |
| Premium | 100 requests per 2 seconds | 400 requests per 2 seconds |
| Ultimate | 120 requests per 2 seconds | 480 requests per 2 seconds |

Note the burst limit counts **requests**, not tokens. It is a separate mechanism from the daily budget. The stated rationale (Rate limiting page):

> These burst limits are designed to protect against rapid, high-volume API calls that could deplete the entire daily budget too quickly, potentially locking a company out from API access until the next daily reset.

**Search API burst limits, verbatim** (Rate limiting page):

> The Search API has unique burst limits that are consistent across all authentication types and subscription plans:

| Plan | API limit |
| --- | --- |
| Lite | 10 requests per 2 seconds |
| Growth | 10 requests per 2 seconds |
| Premium | 10 requests per 2 seconds |
| Ultimate | 10 requests per 2 seconds |

The docs do not enumerate which paths count as "the Search API". By the naming in the v2 spec the candidates are `GET /itemSearch`, `GET /itemSearch/field`, `GET /deals/search`, `GET /persons/search`, `GET /organizations/search`, `GET /products/search`, `GET /leads/search`, `GET /projects/search` — but that mapping is inference from path names, not a documented list.

**No other endpoint-specific ceiling is documented.** The Search API is the only endpoint family with its own burst ceiling on the rate limiting page.

---

## 4. Response headers

**Verbatim table** (Rate limiting page), under the heading "HTTP headers and response codes", introduced by "Pipedrive burst limits have the following response headers:":

| Header | Description |
| --- | --- |
| `x-ratelimit-limit` | The maximum number of requests current access_token or api_token can perform per 2-second window. |
| `x-ratelimit-remaining` | The number of requests left for the 2-second window. |
| `x-ratelimit-reset` | The remaining window before the rate limit resets. |
| `x-daily-requests-left` | Indicates how many requests you can still make to POST / PUT endpoints during the ongoing day (calculated in UTC). Applicable only to api_token requests. |

Reading this against the ticket's questions:

- **Remaining burst allowance**: `x-ratelimit-remaining`. Documented, usable, counts requests.
- **Burst reset time**: `x-ratelimit-reset`. Documented as "the remaining window before the rate limit resets" — the **unit is not stated** (seconds? milliseconds? a timestamp?).
- **Remaining daily token budget**: **no such header is documented.** `x-daily-requests-left` is not it. It counts *requests* not *tokens*, it applies only to *POST/PUT* endpoints, and only to `api_token` (not OAuth) requests. For a GET-only tool it is meaningless.

### Contradiction in Pipedrive's own docs

The Optimizing guide states:

> **Respect Rate Limit Headers and 429 Responses:** The Rate Limit Headers provide information on remaining token counts and reset times, allowing developers to monitor and manage request frequency.

The rate limiting page's header table describes no header carrying a token count. The two pages disagree. Neither page names a token-budget header. Resolving this requires observing a real response; it cannot be resolved from documentation.

---

## 5. The 429 response

**Trigger for daily exhaustion, verbatim** (Rate limiting page):

> Once the daily budget is fully depleted, all further API requests will be rejected with a 429 (Too Many Requests) status code. These requests will remain blocked until the budget resets the following day, at the designated reset time based on the server's timezone

**Status code table** (HTTP status codes page):

| `429` | Too Many Requests | Rate limit has been exceeded |

**The 429 body shape is not documented anywhere.** Neither the rate limiting page, the HTTP status codes page, nor the Responses page shows a 429 example. Grepping both published OpenAPI documents for `429` and "Too Many" returns **no matches at all** — Pipedrive's specs do not declare a 429 response on any operation. So the generated client will have no type for it, and `pd` must handle 429 outside the generated types.

**`Retry-After` is not documented.** The string does not appear on the rate limiting page in any casing. This is an absence of documentation, not proof the header is absent from real responses.

**Daily exhaustion is not distinguishable from burst exhaustion by anything documented.** Both produce a bare 429. There is no documented error code, body field or header that separates the two.

An *inference*, not a documented fact: a 429 accompanied by `x-ratelimit-remaining` greater than 0 would imply the daily budget rather than the 2-second burst window, since the burst counter is not exhausted. This is untested and depends on Pipedrive emitting the burst headers on a daily-budget 429 at all, which is not documented.

**403 escalation, verbatim** (Rate limiting page):

> Only the high volume traffic coming from api_token integrations will be blocked.

> In order to protect ourselves from online attacks caused by misconfigured API integrations, users abusing our system by not respecting our rate limits and keeping up the high volume of traffic despite getting the 429 response code, will also get the 403 response code. When getting the 403 response code, the answer will be an HTML error page with the message "This error is produced by Cloudflare. See troubleshooting guide here.", informing the user that one's access has been denied

This is a real hazard for `pd`: a naive retry loop against a 429 escalates to a Cloudflare block on the whole company's `api_token` traffic. Note the 403 body is **HTML**, not the JSON envelope, so a client that assumes JSON on every response will fail to parse it.

---

## 6. Is the budget readable without spending a request?

**No documented API endpoint exposes the budget or its remaining balance.** The only reporting surface the docs name is a UI dashboard (Rate limiting page):

> The company's API usage statistics can be found in the API Usage Dashboard within Company Settings.

Plus email notifications to administrators, not to the integration (Rate limiting page):

> **75% Notification:** When usage reaches 75% of the daily budget, an automated email will be sent to the company administrators. This notification is intended as an early warning, giving time to review API usage or adjust integrations if needed.
>
> **100% Notification:** Upon reaching 100% of the daily token budget, a second email notification will be sent to inform the administrator that the budget has been exhausted.

Neither is machine-readable by `pd`.

There is also no documented endpoint that reports the plan tier or seat count — the two inputs to the budget formula — so `pd` cannot compute the budget size either. (`GET /users` in v1 could be counted to approximate seats, at a cost of 20 tokens, but "seats" as billed is not necessarily the count of user records, and the docs do not define it.)

**Consequence**: a budget guard in `pd` cannot know the denominator or the remaining balance. It can only know what `pd` itself has spent, using the `x-token-cost` values. Any guard is local and self-reported, and cannot see spend by colleagues' integrations against the same shared pool. `--max-requests` as a hard local ceiling is the only mechanism the documentation actually supports.

---

## Open questions / not documented

1. **No header reports remaining daily token budget.** Confirmed absent from the documented header table. Whether an undocumented header exists can only be settled by inspecting a real response.
2. **The Optimizing guide and the rate limiting page contradict each other** on whether the rate limit headers carry token counts. Unresolvable from documentation.
3. **`x-ratelimit-reset` unit is not stated.** "The remaining window before the rate limit resets" — seconds, milliseconds or an absolute timestamp is not said.
4. **429 response body shape is not documented,** and no 429 response is declared anywhere in either published OpenAPI document.
5. **`Retry-After` is not mentioned** in the rate limiting documentation. Presence or absence on real responses is unknown.
6. **Daily-budget exhaustion vs burst exhaustion cannot be distinguished** by any documented field. Only prose distinguishes them.
7. **The server timezone for the daily reset is not named.** "midnight at server's timezone". Note `x-daily-requests-left` is separately documented as UTC-based, which does not license assuming the token budget resets in UTC.
8. **"Number of seats" is not defined** in the budget formula, and no endpoint is documented to report it or the plan tier.
9. **Whether token cost varies with the `limit` parameter is not addressed.** The specs model cost as one flat scalar per operation, which implies it does not, but no prose confirms it.
10. **The exact membership of "the Search API"** for the 10-requests-per-2-seconds limit is not enumerated. The path list above is inference from naming.
11. **Whether the Search API's 10 req/2 s allowance is separate from or carved out of the main burst allowance** is not stated. Unknown whether a search request also consumes the general burst counter.
12. **Whether burst limits are truly per token or per user** — the same page says both.
13. **Whether the burst-limit headers are returned on all responses or only near/at the limit** is not stated.
14. **Cost of a request that returns an error** (400, 404, 401) is not documented. Whether a failed request still spends tokens is unknown, which matters for retry policy.
15. **v2 cost stability.** The `x-token-cost` values are read from a spec that Pipedrive regenerates. Nothing documents a change policy or deprecation notice for cost changes, so a committed cost table in `pd` can silently drift from reality.
