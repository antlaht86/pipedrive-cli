# Pipedrive authentication: API token versus OAuth

Type: research
Status: resolved

## Question

What are the real authentication options for a locally-run read-only CLI?

- The API token: where a user obtains it, whether it is per-user or per-company, what it is scoped to, whether it can be scoped down to read-only, whether it expires and how it is revoked.
- How the token is transmitted on v2 — header, query parameter, or both — and whether v1 differs.
- The company domain question: whether the base URL is per-company and how it is discovered.
- OAuth: what it requires (registered app, redirect URI, client secret), the available scopes and whether a read-only scope set exists, token lifetime and refresh mechanics, and whether an unpublished private app is a supported path.
- Whether either mechanism identifies which company account and which user the credential belongs to, via an endpoint that costs little.
- How rate-limit budget attribution differs between a token and an OAuth app — whether an OAuth app gets its own pool or draws from the same company pool.

The last point matters: if OAuth changes budget attribution, it stops being purely an auth decision.

## Answer

Findings: [research/05-auth-mechanisms.md](../research/05-auth-mechanisms.md).

**An API token cannot be scoped read-only. At all.** The `api_key` security scheme carries no scopes — every `security:` entry in the spec is literally `- api_key: []` — and the same token authorises `DELETE /deals/{id}` exactly as it authorises `GET /deals`. Pipedrive's own words: a token is "tied to a specific user and company, giving access to all user's data". The only write restriction available is a permission set on the *human user account*, which would mean provisioning a dedicated restricted user and consuming a seat.

**With an API token, the read-only property is enforced solely by `pd`'s own code.** That is a materially weaker guarantee than the map assumed, and it has been raised as its own decision ticket.

**OAuth does offer `:read` scopes** for every relevant resource, so an OAuth credential can be genuinely write-incapable.

**Auth choice does not protect the daily budget.** Both mechanisms draw from the same shared company pool — verbatim, OAuth "tokens are drawn from the end-user's account budget". Budget safety must come from `--max-requests`, caching and client-side accounting, never from the auth mechanism.

**What OAuth does buy is burst headroom**: 80–480 req/2 s versus 20–120 for an API token, roughly 4×. Because burst is per token, a dedicated OAuth install also gives `pd` its own burst lane instead of contending with whatever else uses that human's api_token. The Search API's 10 req/2 s is uniform across both.
