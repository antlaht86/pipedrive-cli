# Research: Pipedrive authentication — API token versus OAuth

Ticket: `.scratch/pd-cli-design/issues/05-research-auth-mechanisms.md`
Date: 2026-08-11
Sources: Pipedrive official developer documentation and Pipedrive's own OpenAPI specs only. No live API calls were made.

Primary artefacts used:

- OpenAPI v2 spec: <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml> (downloaded, 1.0 MB; line numbers below refer to that file)
- OpenAPI v1 spec: <https://developers.pipedrive.com/docs/api/v1/openapi.yaml> (downloaded, 1.8 MB)

---

## 1. How each mechanism transmits the credential

### API token

The v2 spec declares exactly three security schemes (`components.securitySchemes`, openapi-v2.yaml:23094):

```yaml
  securitySchemes:
    basic_authentication:
      type: http
      scheme: basic
      description: 'Base 64 encoded string containing the `client_id` and `client_secret` values. The header value should be `Basic <base64(client_id:client_secret)>`.'
    api_key:
      type: apiKey
      name: x-api-token
      in: header
    oauth2:
      type: oauth2
      ...
```

Source: <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml> (`components.securitySchemes`)

- The token goes in the **`x-api-token` request header**. `in: header`, not query.
- The prose doc agrees: "the token must be provided in the `x-api-token` header for all requests" — <https://pipedrive.readme.io/docs/core-api-concepts-authentication>
- **No `api_token` query parameter exists anywhere in either spec.** `grep -c api_token` returns 0 matches in both openapi-v2.yaml and openapi-v1.yaml. The historic `?api_token=` query form is not part of the documented surface today.
- **v1 does not differ.** The v1 spec's `securitySchemes` block (openapi-v1.yaml:37117) is byte-identical in shape: same `basic_authentication`, same `api_key` / `x-api-token` / `in: header`, same `oauth2` block with the same authorization and token URLs. Source: <https://developers.pipedrive.com/docs/api/v1/openapi.yaml>
- `basic_authentication` is not an API auth mode for data endpoints. It authenticates the app itself against the OAuth token endpoint (`client_id:client_secret`).

### OAuth 2.0

From the same `securitySchemes` block (openapi-v2.yaml:23103):

```yaml
    oauth2:
      type: oauth2
      description: 'For more information, see https://pipedrive.readme.io/docs/marketplace-oauth-authorization'
      flows:
        authorizationCode:
          authorizationUrl: 'https://oauth.pipedrive.com/oauth/authorize'
          tokenUrl: 'https://oauth.pipedrive.com/oauth/token'
          refreshUrl: 'https://oauth.pipedrive.com/oauth/token'
```

- Authorization Code flow only. No client-credentials, no device flow, no PKCE-only variant is declared.
- The `access_token` is sent as a bearer token; the token response carries `"token_type": "bearer"`. Source: <https://pipedrive.readme.io/docs/marketplace-oauth-authorization>
- Token exchange at `POST https://oauth.pipedrive.com/oauth/token` authenticates with `Authorization: Basic <base64(client_id:client_secret)>`. Source: <https://pipedrive.readme.io/docs/marketplace-oauth-authorization>

Every operation in the v2 spec accepts either scheme. Sample (openapi-v2.yaml:89):

```yaml
      security:
        - api_key: []
        - oauth2:
            - 'activities:read'
            - 'activities:full'
```

The two entries are alternatives (OR). `api_key: []` carries **no scope list** — see section 2.

---

## 2. Can a credential be scoped READ-ONLY?

**This is the decisive difference between the two mechanisms.**

### API token: no. Not scopeable at all.

- The `api_key` scheme is `type: apiKey`. OpenAPI apiKey schemes carry no scopes, and every `security:` entry in the spec is literally `- api_key: []` — the empty array is structural, there is nothing to put in it. Source: <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml>
- "An API token is tied to a specific user and company, giving access to **all user's data**." — <https://pipedrive.readme.io/docs/core-api-concepts-authentication>
- The same token authorises `POST /deals`, `PUT /deals/{id}` and `DELETE /deals/{id}` exactly as it authorises `GET /deals` — every write operation in the spec lists `- api_key: []` in its `security` block (e.g. openapi-v2.yaml:417, `- api_key: []` / `- oauth2: ['activities:full']` for a create operation).
- The only write restriction available is **not on the credential** but on the *Pipedrive user* the token belongs to: permission sets govern which actions a user may perform, and a separate "use API" toggle per permission set governs API access at all. Sources: <https://pipedrive.readme.io/docs/enabling-api-for-company-users>, <https://developers.pipedrive.com/docs/api/v1/PermissionSets>
  - That is an account-administration control over a human user account, not a credential property. Using it to get read-only would mean creating a dedicated restricted Pipedrive user (consuming a seat) and reading through it.

**Conclusion:** with an API token, `pd`'s read-only property is enforced *only* by `pd`'s own code. The credential itself is fully write-capable.

### OAuth: yes. `:read` scopes exist for every relevant resource.

Verbatim from `securitySchemes.oauth2.flows.authorizationCode.scopes` (openapi-v2.yaml:23111–23139), source <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml>:

| Scope | Description (verbatim, abridged where marked) |
|---|---|
| `base` | Read settings of the authorized user and currencies in an account |
| `deals:read` | Read most of the data about deals and related entities - deal fields, products, followers, participants; all notes, files, filters, pipelines, stages, and statistics. Does not include access to activities (except the last and next activity related to a deal) |
| `activities:read` | Read activities, its fields and types; all files and filters |
| `contacts:read` | Read the data about persons and organizations, their related fields and followers; also all notes, files, filters |
| `products:read` | Read products, its fields, files, followers and products connected to a deal |
| `projects:read` | Read projects and its fields, tasks and project templates |
| `users:read` | Read data about users (people with access to a Pipedrive account), their permissions, roles and followers |
| `recents:read` | Read all recent changes occurred in an account… |
| `search:read` | Search across the account for deals, persons, organizations, files and products… |
| `leads:read` | Read data about leads and lead labels |
| `goals:read` | Read data on all goals |
| `mail:read` | Read mail threads and messages |

Write-capable counterparts (`deals:full`, `activities:full`, `contacts:full`, `products:full`, `projects:full`, `leads:full`, `goals:full`, `mail:full`, `admin`, `deal-fields:full`, `product-fields:full`, `contact-fields:full`, `project-fields:full`) exist in the same list and are simply **not requested**.

- `base` is mandatory and always enabled for all apps. It is read-only. Source: <https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations>
- "`access_token` is bound to the scopes your app asked permissions for from the user, so requests will be denied if they will be executed against the API endpoints that are not in these scopes." Source: <https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations>
- Users accept or deny the whole scope package; the doc advises requesting only necessary scopes. Same source.

**Caveat for custom-field resolution.** The `*-fields:full` scopes are the only field-schema scopes offered — there is no `deal-fields:read`. However `deals:read` explicitly includes "deal fields" and `contacts:read` includes "contacts-related fields", so reading field schemas for custom-field resolution should be covered by the `:read` scopes without requesting any `:full` scope. Not independently confirmed against a live call.

**Caveat: `mail:full` is described as write-capable but the mandatory-read distinction is clean elsewhere.** `pd` needs none of the mail scopes.

---

## 3. Per-user or per-company

Both mechanisms are **per-user within a company**, never company-wide service credentials.

- API token: "An API token is tied to a specific user and company, giving access to all user's data." — <https://pipedrive.readme.io/docs/core-api-concepts-authentication>
- A user gets "a different `api_token` for every company the user is a part of", and "you can only have one active API token at any time". — <https://pipedrive.readme.io/docs/how-to-find-the-api-token>
- Found in the UI at: "account name (on the top right) > Company settings > Personal preferences > API". — same source
- Revocation is by regeneration, and it is destructive: changing the API token means all existing integrations on the old token "will not be able to make successful requests against our API and stop working". — <https://pipedrive.readme.io/docs/core-api-concepts-authentication>
- The API token itself has **no documented expiry**. It lives until regenerated.
- OAuth: the access token is issued to the installing user of that company. Lifetime is given by `expires_in` in the token response ("The maximum time in seconds until the `access_token` expires"). The `refresh_token` "will expire if it isn't used in **60 days**. Each time `refresh_token` is used, its expiry date is **reset** back to **60 days**", and on refresh "the same `refresh token` will be issued in the response" — i.e. **no refresh-token rotation**. Source: <https://pipedrive.readme.io/docs/marketplace-oauth-authorization>

---

## 4. Base URL and company domain

- The v2 spec declares one server: `https://api.pipedrive.com/api/v2` (openapi-v2.yaml:5–6). The v1 spec declares `https://api.pipedrive.com/v1` (openapi-v1.yaml:5–6). Source: <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml>
- The prose docs prescribe the company-domain form instead: requests use `https://companydomain.pipedrive.com/api/v2/[endpoint]`. Source: <https://pipedrive.readme.io/docs/core-api-concepts-authentication>; endpoint shape `https://{COMPANYDOMAIN}.pipedrive.com/api/v2/deals` per <https://pipedrive.readme.io/docs/core-api-concepts-requests>
- Reason given for preferring the company domain: it helps route the request to the correct data centre, so requests are faster. Source: <https://pipedrive.readme.io/docs/how-to-get-the-company-domain>
- `https://api.pipedrive.com/...` is nonetheless a working host — Pipedrive's own documented example for discovering the domain calls it directly:

  ```
  curl --request GET \
    --url https://api.pipedrive.com/v1/users/me \
    --header 'x-api-token: YOUR_API_TOKEN_HERE'
  ```

  Source: <https://pipedrive.readme.io/docs/how-to-get-the-company-domain>

**How the domain is discovered — three documented ways** (same source):

1. Manually from the browser URL when logged into the Pipedrive app.
2. With an API token: `GET /v1/users/me` and read `company_domain` from the JSON.
3. With OAuth: the token endpoint response contains `api_domain` — "The base URL path, including the `company_domain`, where the requests can be sent to". Source: <https://pipedrive.readme.io/docs/marketplace-oauth-authorization>

So OAuth needs **zero** extra API calls to learn the base URL; the API token path needs one cheap call (see next section).

---

## 5. Identifying the company and user cheaply

`GET /users/me` — **v1 only. It does not exist in the v2 spec** (`grep "^  /users" openapi-v2.yaml` returns nothing; the path is at openapi-v1.yaml:35478).

From the v1 spec, verbatim:

```yaml
  /users/me:
    get:
      summary: Get current user data
      description: 'Returns data about an authorized user within the company with bound company data: company ID, company name, and domain...'
      x-token-cost: 2
      operationId: getCurrentUser
      security:
        - api_key: []
        - oauth2:
            - base
```

Source: <https://developers.pipedrive.com/docs/api/v1/openapi.yaml>

- **Cost: 2 tokens** from the daily budget (`x-token-cost: 2`). Cheap.
- Requires only the `base` scope under OAuth — the mandatory scope. So it works for any OAuth install regardless of what else was granted.
- Response includes `id`, `name`, `email`, `active_flag`, `timezone_name`, `role_id`, `permission_set_id`, `company_id`, `company_name`, `company_domain`. Source: openapi-v1.yaml response schema for `/users/me`.

This single call answers "which company, which user, which permission set, which domain" for both mechanisms.

Note for the client design: the spec is annotated with per-operation `x-token-cost` throughout — 213 occurrences in the v1 spec, 158 in the v2 spec. The generated client's source of truth for budget accounting is therefore already in the spec files.

---

## 6. Rate-limit budget attribution — the verdict

**The daily budget is the same shared company pool for both mechanisms. OAuth does not get its own daily pool.**

- Formula: "30,000 base tokens × subscription plan multiplier × number of seats (+ purchased API Token top-ups)". The budget is per company account and is "shared among all users within that account". It covers "API traffic authenticated by API tokens or OAuth tokens" and does not cover UI actions. Source: <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>
- Decisive statement for OAuth: "**For Marketplace applications using OAuth authentication, tokens are drawn from the end-user's account budget.**" And: "Exceeding the token budget on one account will not impact other accounts using the same application." Source: <https://pipedrive.readme.io/docs/guide-for-optimizing-api-usage>
- Admins get a warning email at 75 % of the daily budget; exhaustion returns `429`. Source: <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>

**Burst limits do differ, and here OAuth is materially more generous.**

- Burst limiting is "considered per token, not per company", on a **rolling 2-second window**, applied at the individual user level. Source: <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>
- API tokens: **20–120 requests / 2 s**, depending on plan.
- OAuth apps: **80–480 requests / 2 s**, depending on plan — roughly 4× the API-token allowance.
- Search API: **10 requests / 2 s**, uniform across all plans and both auth types.
- Source for all four figures: <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>
- Response headers: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-daily-requests-left`. Same source.

**Verdict:** auth choice does **not** protect colleagues' daily budget. Whatever `pd` spends, it spends out of the shared company pool either way. What OAuth buys is a ~4× larger burst ceiling, and — because burst is per token — a dedicated OAuth install gives `pd` its own burst lane instead of contending with whatever else uses that human user's api_token. Budget safety must still come from `--max-requests`, caching, and the client-side budget accounting, not from the auth mechanism.

Historic note, superseded: a 2018 changelog announced equal windows ("20/40/80 requests per 2 seconds per `access_token` (or `api_token`)" for Silver/Gold/Platinum) — <https://developers.pipedrive.com/changelog/post/new-rate-limits-window>. The current rate-limiting page supersedes it with distinct api_token vs OAuth figures.

---

## 7. What OAuth actually costs to set up

- A **developer sandbox account** is required: "You must have a developer sandbox account for app creation to see Developer Hub." Source: <https://pipedrive.readme.io/docs/marketplace-registering-the-app>
- App registration happens in **Developer Hub** and requires a **callback URL**: "Insert a link where an authorization code will be sent if the user approves or declines the installation of your app." Same source.
- `client_id` + `client_secret` are issued; the secret must be present at token exchange (Basic auth). A locally-run CLI therefore must embed or store a client secret.
- App statuses for public apps are draft / in review / unpublished / published. "Your app is approved by the Marketplace team. It remains unpublished as you have to publish it yourself." Same source.

**Private apps are a first-class, documented path — Marketplace publication is NOT required.** Source: <https://pipedrive.readme.io/docs/marketplace-registering-a-private-app>

- "Private apps, aka internal apps, enable you to share your integration with any user/company in Pipedrive via a direct, unlisted installation link."
- Private apps do not go through the Marketplace app approval process and are never published in the Marketplace; they have no listing or landing page.
- The installation link is found in the Developer Hub dashboard — the three-dot menu next to the app name, or the "Share app" button in the **OAuth & access scopes** tab.
- Only the app-creation parts of the registration form must be completed.
- "Unlisted" and "private" are the same thing; unlisted apps were moved to the Private apps section in Developer Hub. Source: <https://pipedrive.readme.io/docs/developer-hub>
- A developer sandbox account is still required to see Developer Hub at all.

This makes OAuth genuinely viable for an internal CLI: register a private app requesting only `base` + the `:read` scopes, install it into the real company account via the direct link, no Marketplace review.

---

## Open questions / not documented

1. **Whether a private app has an install-count or company-count limit.** The private-app doc states no maximum. Also unstated: whether a private app must still nominate a callback URL reachable over HTTPS (a locally-run CLI would want `http://localhost:PORT`), and whether `localhost` redirect URIs are accepted. This is the main remaining unknown on the OAuth path. Source checked: <https://pipedrive.readme.io/docs/marketplace-registering-a-private-app>
2. **Whether the legacy `?api_token=` query parameter still works.** It appears in neither spec (0 grep matches in v1 and v2) and the auth doc says header only, but no explicit removal/sunset announcement was located. Treat as unsupported.
3. **Exact `expires_in` value for an OAuth access token.** The docs describe the field but state no concrete number (commonly reported as 3600 s, but that is not a primary-source claim).
4. **Whether `deals:read` / `contacts:read` alone suffice for the custom-field schema endpoints** (`/dealFields`, `/personFields`, `/organizationFields`) needed for hash resolution. The scope descriptions imply yes; only `*-fields:full` scopes exist explicitly, and none of them has a `:read` counterpart. Unverified without a live token.
5. **Per-plan mapping of the burst numbers.** The rate-limiting page gives the ranges (20–120 and 80–480) but the plan-by-plan table was not captured verbatim here.
6. **The exact plan multipliers** in the daily-budget formula.
7. **Whether a Pipedrive permission set can be made genuinely read-only** while still having "use API" enabled — the permission-set docs describe action-level control but do not present a canonical read-only preset.
8. **Whether OAuth token refresh calls themselves consume daily budget tokens.** Not stated; the `oauth.pipedrive.com` host is outside the annotated API spec.
