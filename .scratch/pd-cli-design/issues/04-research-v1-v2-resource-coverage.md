# Which resources are v1-only, and what the v2 spec omits

Type: research
Status: resolved

## Question

Where does the incomplete v1 to v2 migration leave a generated-v2 client?

- The current v2 coverage: which resources have v2 read endpoints today.
- Which resources a read-only CRM tool would plausibly want that exist only in v1 — and specifically whether the field-schema endpoints from the custom field ticket are among them.
- Whether Pipedrive publishes a separate v1 OpenAPI spec, its URL, and whether it is of usable quality for `@hey-api/openapi-ts`.
- Whether v1 and v2 share authentication, base URL, rate-limit accounting and error shapes, or differ in any of these.
- Whether v1 endpoints use the same cursor pagination or the older offset pagination, and what their `limit` maximum is.
- Any published deprecation or sunset dates for v1 endpoints.

Feeds the decision on how v1-only resources are exposed through a client generated from the v2 spec.

## Answer

Findings: [research/04-v1-v2-resource-coverage.md](../research/04-v1-v2-resource-coverage.md).

**This ticket's premise was wrong in the useful direction**: the field-schema endpoints are fully present in v2, so custom field resolution needs no v1 fallback at all.

The gap is a **three-class taxonomy**, not two:

- **Class A** — v1 endpoints with a v2 equivalent. Deprecated, out of support since 1 Aug 2026, absent from the published v1 spec, and twice the token cost. `pd` should never call these.
- **Class B** — v1-only with no v2 equivalent, **not deprecated**, and the supported path: Leads, Notes, Users, Currencies, ActivityTypes, Filters, `leadFields`, `noteFields`, and entity changelog/flow history.
- **Class C** — v2-only.

Reaching Class B means a second generated client: different base URL (v2 is strict about it), a genuinely different pagination model, a different response envelope, and lower-quality generated types. Authentication is **identical** across both, and error shapes are derivable from neither spec.
