# The search surface, and what the stricter search rate limit costs

Type: grilling
Status: open

Blocked by: 16, 19

## Question

[ADR-0009](../../../docs/adr/0009-command-surface-and-manifest.md) deliberately left every search
endpoint out of the first surface. v2 offers seven: `/deals/search`, `/persons/search`,
`/organizations/search`, `/products/search`, `/leads/search`, `/itemSearch` and `/itemSearch/field`.
Does `pd` expose any of them, and how?

- **Shape.** A third verb (`pd deals search <term>`), a resource of its own (`pd search <term>`
  wrapping `/itemSearch`), or a flag on `list` (`pd deals list --search <term>`)? ADR-0009 fixed the
  grammar as `<resource> <verb>` with exactly two verbs and two named exception groups; a third verb
  is an amendment to that ADR, not a free choice, and the read-only refusal message would change.
- **What the stricter limit does.** Research 01 found the Search API rate-limited harder than the
  rest. Whether that needs its own limiter is [ticket 17](17-grilling-concurrency-default.md)'s call;
  what this ticket owns is whether a search command can share `--max-requests` and the budget guard
  honestly, or whether search needs a ceiling of its own the way `--resolve` needed
  `--resolve-budget`.
- **Pagination.** Search results are cursor-paginated too. Does `--limit` mean the same thing, and
  does relevance ordering make a partial result more or less useful than a partial list?
- **`/leads/search` is the awkward one.** Leads are out of scope
  ([ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md) ruled them out), yet
  their search endpoint is v2 and would come free with a generic search command. Does the scope
  boundary hold, or does `itemSearch` re-admit leads through the back door?
- **`/itemSearch/field`** searches within a single field. Is it a distinct capability worth a
  command, or the same command with a `--field` flag?
- **Filters.** Pipedrive's saved Filters are v1-only and out of scope, so "filtering" in `pd` can
  only mean query parameters the v2 list endpoints already accept. Enumerate what those are before
  deciding whether they deserve flags — that is a fact to look up, not a decision.

Record as an ADR.
