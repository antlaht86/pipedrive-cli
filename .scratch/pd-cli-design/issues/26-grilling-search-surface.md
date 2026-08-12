# The search surface, and what the stricter search rate limit costs

Type: grilling
Status: resolved

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

- **[ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) §6 constrains the search term.**
  `--verbose` logs request URLs, and query values print only for an allowlist (`limit`, `cursor`,
  `sort_by`, `sort_direction`, `include_option_labels`, `ids`). Whatever parameter this ticket adds for
  a search term is `[redacted]` by default and must not be added to that allowlist — a search term is
  company data. Nothing to decide unless this ticket wants the opposite.

- **[ADR-0016](../../../docs/adr/0016-field-projection.md) §5 draws a boundary this ticket owns the
  other side of.** `--fields` removes fields and never records, so `emitted`, `skipped` and
  `duplicates` keep their meanings and the trailer gains nothing. Any record-dropping behaviour is
  this ticket's to invent — including whether it needs a fourth subtractive counter on the trailer, or
  whether a filtered-out record was simply never fetched and therefore counts as nothing at all.
- ADR-0016 §10 already added `custom_fields` to ADR-0015 §6's allowlist. A search `term` still is not
  eligible, for the reason given above.

## Answer

Recorded as [ADR-0017](../../../docs/adr/0017-search-and-list-filtering.md). Resolved without a
grilling dialogue: the user's invocation directed that nothing answerable from the material be put to
them, and every open point here was answerable from `openapi-v2.yaml` and the prior ADRs. The
decisions are therefore recorded with their rejected alternatives, and an *Assumptions recorded rather
than asked* section, in ADR-0009's manner.

**The fact that decided the shape question.** A search hit is not a record: `/deals/search` returns
`{ result_score, item }` where `item` is a truncated projection — no `custom_fields` object, no
`add_time`, and a different field set per entity. So `pd deals list --search <term>` is dead, because
it would make a flag change the record shape, which is the invariant ADR-0016 §5 and ADR-0008 §1
exist to protect. Search must be its own command.

**What exists.** A third verb — `pd deals search`, `pd persons search`, `pd organizations search`,
`pd products search` — amending ADR-0009 §1, whose §6 had already forbidden the refusal message from
naming the verb inventory. Plus a tenth resource `items` (`pd items search <term>`, wrapping
`/itemSearch`) that has neither `list` nor `get`, amending §3. Making cross-entity search a resource
rather than a fourth verbless exception keeps ADR-0009 §8's exception list closed.

**The scope boundary holds.** `item_types` is pinned to `deal,person,organization,product` on every
request and `--types` can only narrow within it, so `itemSearch` does not re-admit leads, files, mail
attachments or projects through the back door. `/leads/search` gets no command.

**Four collisions found and fixed**, all of which would have shipped silently:

- `item.type` (`"deal"`) collides with ADR-0002's line kind — dropped, `record_type` carries it.
- The hit's `custom_fields` is `string[]` (matched values) where ADR-0008 §1 defines a hash-keyed
  object — renamed `matched_custom_field_values`; `notes[]` likewise `matched_notes`.
- The endpoints' `fields` query parameter (search *in*) collides with ADR-0016's `--fields` (emit) —
  the flag is `--search-in`.
- `filter_id` makes the API silently ignore `ids` — the combination is a usage error, exit 2, offline.

`owner`, `stage`, `person` and `organization` objects are flattened to ADR-0008 §3's existing
`*_id` / `*_name` pairs, so a hit's reference fields are byte-compatible with a resolved record and
`--resolve` has only `owner_id` left to do — from the cache, at zero requests.

**The budget question, answered against a reason rather than a preference.** Search shares
`--max-requests` and gets no ceiling of its own: `--resolve-budget` exists because resolution requests
are *implicit*, and a search command's requests are the ones the caller asked for. ADR-0011 §10's
conservative reading of research 01 gap 11 is **confirmed** — a search request is assumed to spend both
allowances — on ADR-0001's asymmetric-consequence argument.

**`--limit` is unchanged and the trailer gains nothing**, because a record excluded by a search term or
a filter flag was never fetched. Dedup keys on `(record_type, id)` for the mixed `items` stream.
Relevance ordering makes a partial search the *best* matches rather than an arbitrary prefix, which is
said in `AGENTS.md` without becoming a default `--limit`.

**The filtering half.** The v2 list vocabulary was enumerated from the spec and fifteen flags survive
(`--ids`, `--owner-id`, `--person-id`, `--org-id`, `--deal-id`, `--pipeline-id`, `--stage-id`,
`--status`, `--done`/`--not-done`, `--updated-since`, `--updated-until`, `--sort-by`,
`--sort-direction`, `--filter-id`), command-scoped so ADR-0009's global table stays at nine.
`lead_id` is dropped. `--filter-id` is exposed despite being non-enumerable, because a saved filter is
server-side selection at zero extra requests. `--updated-since` with `--sort-by update_time` is the
honest incremental read ADR-0003 §6 refused to fake with a resumption token.

**Redaction.** Fifteen enum and numeric parameters join ADR-0015 §6's allowlist; `term` is refused
permanently and the refusal is recorded so it does not read as an oversight later.

No new error variant, no exit-code change, no `manifest_version` bump — everything here is additive.
