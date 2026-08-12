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

## Context added while resolving other tickets

- [ADR-0010](../../../docs/adr/0010-budget-guard.md) removes an option this ticket might have assumed:
  there is **no daily token guard**, so a search surface cannot lean on one to make an expensive
  endpoint safe. The only quantitative guard is `--max-requests`, counted in network requests, with no
  default.
- The relevant arithmetic from research 01: a v2 search costs **20 tokens** against a list's 10, and the
  Search API has its own burst ceiling of **10 requests per 2 seconds**, uniform across every plan and
  auth type — roughly a tenth of a Premium account's general allowance. Whether that ceiling is separate
  from or carved out of the general burst counter is documented nowhere (research 01, open question 11),
  and the exact membership of "the Search API" is inference from path names (open question 10).
- [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md) §10 answers the limiter half so this ticket
  does not have to: the rate gate is already **keyed by endpoint family**, so search arrives as a new key
  rather than a rework. Under §2's half-window rule the `search` family gates at **5 requests per
  2 seconds**. What is left here is unchanged — whether search can share `--max-requests` honestly, or
  needs its own ceiling — plus one inherited assumption to confirm or overturn: ADR-0011 takes the
  conservative reading of research gap 11, that a search request spends **both** the search allowance and
  the general one.
