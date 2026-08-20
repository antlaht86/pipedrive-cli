# Spec: `pd` — a read-only Pipedrive CLI for agent consumption

Status: ready-for-agent
Date: 2026-08-13
Design map: [`map.md`](map.md)
Normative detail: [`docs/adr/0001`](../../docs/adr/0001-error-model-and-exit-codes.md) … [`0020`](../../docs/adr/0020-value-formatting-and-absence.md)

This spec consolidates twenty accepted ADRs into one buildable document. Where this spec and an ADR
disagree, the ADR wins and this spec is wrong — except in the three places named in
[Further Notes](#further-notes), where two ADRs disagree with each other and this spec rules.

---

## Problem Statement

An AI coding agent that needs to answer a question about the company CRM has no safe way to ask it.

- **The Pipedrive API is not agent-shaped.** Custom fields arrive as 40-character hashes. Owner,
  person, organization, pipeline and stage references arrive as bare integers. Cursor pagination
  means "all deals" is eighty requests, not one. Some resources are still v1-only. The agent must
  learn all of this before it learns anything about the business.
- **A general-purpose HTTP client is unsafe.** A Pipedrive API token cannot be scoped read-only — the
  same credential that authorises `GET /deals` authorises `DELETE /deals/{id}`. An agent with `curl`
  and a token can destroy CRM records, and nothing in Pipedrive stops it.
- **The daily API budget is shared by the whole company.** It is a token pool per company account,
  drawn on by every colleague's integration. An agent in a retry loop does not merely fail its own
  task; it degrades everyone's. Worse, hammering a 429 earns a Cloudflare 403 that blocks the entire
  company's `api_token` traffic.
- **The agent's context window is the budget it cannot refill.** A forty-thousand-record answer with
  forty fields per record is not an answer; it is an eviction.

Existing tooling solves none of these. A Pipedrive SDK gives an agent write methods. A generic REST
tool gives it no pagination, no resolution and no partiality signal. A human CLI gives it colour,
banners and prose on stdout.

## Solution

`pd` — a single compiled binary, built from this repository with Bun, that reads Pipedrive and cannot
write it.

- **Read-only, structurally.** GET requests only, enforced by four independent layers of `pd`'s own
  code, not by a promise in the README.
- **Machine-first output.** stdout is NDJSON, one `type`-tagged JSON value per line, ending in
  exactly one trailer that always states whether the answer is complete. stderr carries no fact that
  stdout does not also carry.
- **Errors are data.** A typed union of twelve variants, each with a stable `code`, a `retry`
  advisory and an exit code, emitted on stdout in the same shape family as success.
- **Complete pagination by default.** "All deals" means all of them. The cursor is never visible.
  `--limit` bounds the answer in records; `--max-requests` guards the run in network requests, and
  the two are deliberately different things with different exit codes.
- **Legibility on request.** `--resolve` adds names beside ids and labels beside custom-field hashes,
  additively, so the raw output stays byte-identical and diffable.
- **Context economy in the caller's hands.** `--fields` projects, absence is an omitted key rather
  than a `null`, and both compound with `--limit`.
- **Self-describing.** `pd manifest` emits one JSON object naming every command, flag, selectable
  field, line type, warning kind, error code and exit code, so a harness discovers the contract
  instead of hardcoding it.

The primary consumer is an agent on no particular harness. Where agent ergonomics and human
ergonomics conflict, the agent wins; `--pretty` is the human's opt-in, and it is explicitly unstable.

---

## User Stories

### The agent as primary consumer

1. As an AI coding agent, I want `pd deals list` to return every deal across as many cursor pages as
   it takes, so that I never have to learn what a cursor is.
2. As an AI coding agent, I want every output line tagged with a `type`, so that I can dispatch on it
   without guessing what a line is.
3. As an AI coding agent, I want the last line of every run to carry `complete` and `emitted`, so
   that I can read two fields and know whether I have the whole answer.
4. As an AI coding agent, I want a run to end with either a `summary` or an `error` line but never
   both, so that I never have to reconcile two counts.
5. As an AI coding agent, I want failures on stdout rather than stderr, so that a harness which
   swallows stderr still hands me the failure.
6. As an AI coding agent, I want a stable `code` string on every error, so that I can branch on the
   failure class without parsing English prose.
7. As an AI coding agent, I want a `retry` field of `never` / `after` / `not_today` on every error,
   so that I can act correctly on an error code my harness has never heard of.
8. As an AI coding agent, I want `--limit` to exit 0, so that a deliberately bounded query does not
   look like a failure and teach me to ignore exit codes.
9. As an AI coding agent, I want `--max-requests` to exit 3, so that a truncated answer can never be
   mistaken for a complete one.
10. As an AI coding agent, I want `emitted` on the error trailer too, so that I know how many records
    I am holding when a run dies mid-stream.
11. As an AI coding agent, I want `skipped` and `duplicates` always present, so that the gap between
    what was fetched and what I received is auditable.
12. As an AI coding agent, I want records to start arriving in about 250 ms rather than after 20
    seconds of silence, so that a long walk does not look like a hang.
13. As an AI coding agent, I want `pd manifest` to emit one JSON object, so that `JSON.parse(stdout)`
    tells me the entire command surface in one call.
14. As an AI coding agent, I want `manifest_version` as a single integer, so that "can I read this"
    is one comparison rather than semver logic.
15. As an AI coding agent, I want the manifest to list the selectable fields per command, so that I
    can use `--fields` without first running the command unprojected to learn the names.
16. As an AI coding agent, I want an unknown command to tell me `pd` has no write commands at all, so
    that one probe ends the search instead of inviting `update`, then `delete`, then `new`.
17. As an AI coding agent, I want one spelling per concept and no aliases, so that constructing a
    command is never a coin flip.
18. As an AI coding agent, I want `pd <resource> <verb>` to match Pipedrive's own nouns, so that
    documentation I have already read transfers directly.
19. As an AI coding agent, I want `pd docs` to print `AGENTS.md` verbatim, so that harness setup is
    one command and the documentation matches the installed version.

### Context economy

20. As an AI coding agent, I want `--fields title,value,org_id`, so that I pay for three fields
    instead of forty on every record of a large walk.
21. As an AI coding agent, I want `id` emitted whether or not I selected it, so that every record
    remains followable and deduplication remains verifiable.
22. As an AI coding agent, I want a field with no value omitted rather than emitted as `null`, so
    that a typical deal line drops eight to ten keys that say nothing.
23. As an AI coding agent, I want `[]`, `""` and `0` treated as values rather than absence, so that a
    zero-valued deal and a deal with no value are distinguishable.
24. As an AI coding agent, I want an unknown field name rejected offline with exit 2, so that a typo
    never produces plausible output with a field quietly missing.
25. As an AI coding agent, I want a custom-field hash that matched nothing to be a warning rather
    than an error, so that an unfilled field does not fail my run.
26. As an AI coding agent, I want `--fields` on an empty field to yield a shorter line rather than a
    warning, so that projecting over a walk of open deals is not forty thousand warnings.
27. As an AI coding agent, I want key order to follow `pd`'s schema rather than my selector order, so
    that two callers selecting the same fields get byte-identical records.
28. As an AI coding agent, I want `--limit 20` on a search to give me the twenty best matches, so
    that a bounded search is more useful than a bounded list rather than less.

### Legibility

29. As an AI coding agent, I want `--resolve` to turn `owner_id: 12` into `owner_name` beside it, so
    that a record is readable without a second command.
30. As an AI coding agent, I want the raw id kept beside the resolved name, so that I can pass the id
    to the next command and diff two runs meaningfully.
31. As an AI coding agent, I want one `--resolve` flag covering hashes, option labels, owner ids and
    relations, so that I do not have to know which kind of unreadable id I am looking at before I can
    ask for readability.
32. As an AI coding agent, I want resolved custom fields in a parallel `custom_fields_resolved` block
    keyed by hash, so that `custom_fields` is byte-identical with and without the flag.
33. As an AI coding agent, I want that block keyed by hash rather than display name, so that two
    custom fields sharing a display name cannot make the output unparseable.
34. As an AI coding agent, I want an unresolvable id to omit its sibling key entirely, so that I never
    receive a name that is secretly a number.
35. As an AI coding agent, I want `resolved: off | partial | full` on every trailer, so that I can
    detect that early records carry names and later ones do not.
36. As an AI coding agent, I want a resolution failure to degrade to raw ids and exit 0, so that an
    ancillary lookup never kills a forty-thousand-record walk that was otherwise perfect.
37. As an AI coding agent, I want resolved money as `"12000.00 EUR"` with no locale formatting, so
    that the same record produces the same bytes on a laptop and in CI.
38. As an AI coding agent, I want `pd fields list --entity deal` to print hash and display name
    together, so that I can learn an account's custom fields without walking records.

### Querying

39. As an AI coding agent, I want `pd deals search Acme` as a distinct verb, so that a flag never
    changes the shape of a record.
40. As an AI coding agent, I want a search hit tagged `record_type: deal_search_hit`, so that I
    cannot mistake a truncated projection for a full record.
41. As an AI coding agent, I want `pd items search <term>` across deals, persons, organizations and
    products, so that "what does the CRM know about this name" costs one request rather than four.
42. As an AI coding agent, I want `--search-in` to name where to search and `--fields` to name what to
    emit, so that two plausible readings of one flag cannot silently diverge.
43. As an AI coding agent, I want a too-short search term refused offline with exit 2, so that I do
    not spend a shared-budget request to learn a rule the spec states plainly.
44. As an AI coding agent, I want `--sort-by` on a search to be a usage error, so that `pd` never
    lies to me about ordering it cannot control.
45. As an AI coding agent, I want `--updated-since` with `--sort-by update_time`, so that I can read
    a day's changes instead of a CRM's history.
46. As an AI coding agent, I want `--ids 7,9,11` to accept any number of ids and chunk invisibly, so
    that a join over a large walk is not broken by an API ceiling I cannot see.
47. As an AI coding agent, I want an id that returned no record reported once as an `unmatched_ids`
    warning, so that a join silently dropping a row is distinguishable from a row with no fields.
48. As an AI coding agent, I want `--filter-id` with `--ids` refused offline, so that the API
    silently ignoring one of them cannot surprise me.
49. As an AI coding agent, I want the two-command join documented as the answer to "give me the whole
    related record", so that I know it is the design rather than a missing feature.

### Safety — the CRM

50. As a sales operations lead, I want `pd` to be incapable of writing to Pipedrive, so that giving an
    agent CRM access is not giving it CRM deletion.
51. As a maintainer, I want write operations absent from the generated client rather than merely
    unreachable, so that the guarantee is a measurement and not an argument.
52. As a maintainer, I want a non-GET refusal below the wrapper, so that a bug inside the wrapper
    still cannot issue a write.
53. As a maintainer, I want a CI gate that fails the build when a regeneration reintroduces a write
    operation, so that the safety property does not depend on somebody reading a log.
54. As an AI coding agent, I want `write_blocked` as its own error code, so that I stop using `pd`
    entirely rather than filing a bug and trying another command.
55. As a security-conscious operator, I want `pd auth status` to state that my token is write-capable
    every time it runs, so that I am not lulled by the phrase "read-only tool".
56. As a security-conscious operator, I want `pd` to name the restricted Pipedrive permission set as
    the only account-level mitigation, so that I know what `pd` cannot do for me.

### Safety — the shared budget

57. As a colleague sharing the daily token budget, I want an ambiguous 429 treated as budget
    exhaustion, so that a retry loop never earns the company a Cloudflare 403.
58. As a colleague sharing the daily token budget, I want a `blocked` outcome remembered on disk for
    fifteen minutes, so that an agent looping `pd` fifty times does not get fifty fresh retry caps.
59. As a colleague sharing the daily token budget, I want no flag that overrides that sentinel, so
    that the one company-wide safety stop has no documented escape hatch.
60. As a colleague sharing the daily token budget, I want `pd cache clear` and `--no-cache` unable to
    reach the sentinel, so that an ordinary agent recovery reflex does not walk back into the block.
61. As a colleague sharing the daily token budget, I want the burst gate set at half the smallest
    documented plan window, so that `pd` does not consume the entire allowance of a token it shares.
62. As a colleague sharing the daily token budget, I want a 429 to pause every request rather than
    one, so that queued requests do not each earn their own 429 in series.
63. As a colleague sharing the daily token budget, I want retries capped at roughly six seconds of
    stall, so that `pd` gives up before a harness kills it and loses the explanation.
64. As a colleague sharing the daily token budget, I want near-static metadata cached per credential,
    so that repeated runs do not refetch field schemas all day.
65. As a colleague sharing the daily token budget, I want `pd` to say plainly that it does not guard
    the daily budget, so that nobody plans against a guarantee that does not exist.

### Correctness

66. As an AI coding agent, I want every response validated at the boundary, so that stdout only ever
    carries records `pd` has checked.
67. As an AI coding agent, I want one bad record to be skipped rather than to reject its whole page,
    so that a decade-old record does not cost me five hundred good ones.
68. As an AI coding agent, I want a structural failure to end the walk as `invalid_response`, so that
    a body that is not JSON at all is never mistaken for data.
69. As an AI coding agent, I want a Cloudflare HTML body never parsed as JSON, so that a company-wide
    block is never disguised as a schema problem.
70. As an AI coding agent, I want warnings deduplicated by cause, so that forty thousand rejections
    for one reason cost me one line rather than forty thousand.
71. As an AI coding agent, I want records deduplicated across pages, so that keyset-like cursors
    cannot hand me the same deal twice without saying so.
72. As an AI coding agent, I want `--limit` counted after rejection and deduplication, so that asking
    for 100 never yields 97 with no explanation.
73. As an AI coding agent, I want no resumption token, so that `pd` never promises a continuation
    semantics Pipedrive does not offer.
74. As an AI coding agent, I want timestamps passed through byte-for-byte, so that `pd` is never the
    component that is silently wrong about time.
75. As an AI coding agent, I want money as a JSON number with `currency` as a flat sibling, so that I
    can compare and sum without parsing.

### The human operator

76. As a human operator, I want `--pretty` to render an aligned table, so that I can read a result at
    a terminal.
77. As a human operator, I want `--pretty` documented as unstable and never invoked by an agent, so
    that it cannot become a second contract by accident.
78. As a human operator, I want a rewriting status line on stderr when stderr is a TTY, so that a
    twenty-second walk is distinguishable from a hang.
79. As a human operator, I want gate pauses, retries and self-raising ceilings printed as permanent
    lines, so that I can see what paced a slow run even though there is no flag to set it.
80. As a human operator, I want `--verbose` to log one line per request with query values redacted by
    allowlist, so that a future parameter leaks nothing by default.
81. As a human operator, I want response bodies never logged at any verbosity, so that debugging does
    not write the CRM to a file whose permissions `pd` does not control.
82. As a human operator, I want `pd cache info` to report entry ages and the sentinel, so that a
    surprising label or a request-free refusal is explicable.
83. As a human operator, I want `pd auth status` at zero requests and zero writes, so that I can
    diagnose which credential is in play without spending budget.
84. As a human operator, I want a credential file with loose permissions to warn rather than refuse,
    so that `pd` does not block work over an exposure that refusing does not undo.

### Installation and versioning

85. As a harness author, I want `git clone` plus `bun run build` as the one documented install, so
    that setup has no registry, no platform matrix and no signing step.
86. As a harness author, I want the built binary to ignore a `.env` in the directory it is invoked
    from, so that standing in an arbitrary repository cannot silently switch my Pipedrive account.
87. As a harness author, I want `pd` never to poll a registry for updates, so that the tool makes no
    HTTP request that is not a Pipedrive GET.
88. As a harness author, I want MAJOR defined against the agent-visible contract and
    `manifest_version` in lockstep, so that "did the contract break" is answerable from one object.
89. As a harness author, I want `pd --version` to name the commit it was built from, so that two
    self-built binaries reporting the same tag are still distinguishable.
90. As a Windows user, I want `%LOCALAPPDATA%` and `%APPDATA%` supported and the NTFS permission gap
    stated in `pd auth status`, so that the platform works and its weaker promise is not hidden.

### Development

91. As a maintainer, I want `bun test` to cost zero Pipedrive requests mechanically, so that no
    developer can take the company CRM offline by adding a test case.
92. As a maintainer, I want the replay seam below the write guard, so that no test can test its way
    past the read-only property.
93. As a maintainer, I want one injected clock, so that a retry test costs milliseconds instead of
    six seconds and a TTL test is possible at all.
94. As a maintainer, I want no test-only flag or environment variable, so that isolation cannot
    become surface an agent can reach.
95. As a maintainer, I want the live suite invoked by hand and producing a re-recording rather than a
    pass or fail, so that a colleague editing a deal does not turn the build red.
96. As a maintainer, I want a CI gate asserting no credential-shaped string is in the fixture tree and
    no fixture is embedded in the built binary, so that the private repository and the binary a
    colleague builds stay distinct by enforcement rather than by intention.

---

## Implementation Decisions

Each cluster names its normative ADR. The ADR is the detail; this is the shape.

### 1. Runtime, libraries and the generated client — locked, [ADR-0006](../../docs/adr/0006-validation-placement-and-rejection.md), [ADR-0007](../../docs/adr/0007-the-narrow-v1-users-client.md)

- Bun + TypeScript, `strict: true`. Argument parsing via `util.parseArgs`; no CLI framework.
- `zod` for all runtime validation, `neverthrow` for errors as values, `p-limit` for all concurrent
  HTTP work. No substitutes.
- The Pipedrive client is generated by `@hey-api/openapi-ts` from Pipedrive's OpenAPI documents.
  Generated output is committed; regeneration is a documented script; generated code is never
  hand-edited.
- `sdk.client: false`, so no ambient client exists and a generated function cannot be called without
  being handed a client the wrapper constructed.
- `sdk.validator: false`. Generated zod response schemas are run explicitly with `safeParse` inside
  the wrapper, so a parse failure becomes a typed `PdError` rather than an untyped field shared with
  transport failures.
- Two generation jobs, separate output directories: v2 (the bulk), and v1 filtered to the single
  operation `GET /users`. The merge form is not used. Seven other `users` endpoints are excluded, as
  are `users/me`, `users/find`, followers, permissions, role assignments and role settings.
- Schema corrections are `parser.patch` entries against the input spec, never edits to generated
  output. The patch list starts from observed responses: `additional_data.next_cursor` is typed as a
  required string but is `null` on the last page of every list, and `person_id` / `org_id` are typed
  non-nullable but return `null` for an unlinked deal. The `next_cursor` patch is load-bearing — a
  complete walk cannot work at all without it.
- The v1 spec needs no patch, because `pd` defines the user record schema itself.

### 2. The single client module — locked point 7, [ADR-0011](../../docs/adr/0011-concurrency-and-retry.md), [ADR-0013](../../docs/adr/0013-read-only-enforcement.md)

Every HTTP call passes through one module. Rate limiting, retry, concurrency limiting, request
accounting, redaction and logging live there and nowhere else. Both generated clients share one
`guardedFetch`; they differ only in `baseUrl`.

- **Base URL** is fixed at `https://api.pipedrive.com`. The per-company form is not used, because
  learning the company domain requires an operation `pd` does not have.
- **Burst gate**: a rolling 2-second window in front of `p-limit`. `p-limit` bounds requests in
  flight; the gate bounds requests per window, which is what Pipedrive counts. Default **10 requests
  per 2 seconds** — half the smallest documented plan window — raised to half of an observed
  `x-ratelimit-limit` for the remainder of the process, never lowered. An absent header carries no
  information and changes nothing.
- **Gate families**: keyed internally. Every non-search operation is `default`; the search endpoints
  are one `search` family at 5 requests per 2 seconds. A search request is assumed to spend both
  allowances, because the documentation does not say and the cautious error is cheap.
- **Concurrency** is a fixed **4**, derived from the gate rate and the largest genuinely independent
  fan-out in the design. There is no flag, no environment variable and no manifest entry.
- **A 429 pauses the whole gate**, in flight and queued, for the backoff interval.
- **Burst retries**: 3 strikes per run, each wait `x-ratelimit-reset` clamped to at most 2 seconds
  (flat 2 s when absent) — roughly 6 seconds of stall, then `rate_limited`, exit 3.
- **5xx and transport retries**: 3 attempts per request at 250 ms / 1 s / 4 s with full jitter, and
  10 retries per run in total, then `upstream`, exit 1. A separate counter from burst strikes.
- **A 429 not inferable as burst, and a Cloudflare 403, are never retried.**
- **A response is never assumed to be JSON.** The Cloudflare block body is HTML, and 403 is
  overloaded between that block and an ordinary permission failure — they are separated by body
  shape, not by status.
- `--max-requests` headroom is reserved **before** dispatch, and retries count.

### 3. Read-only enforcement — [ADR-0013](../../docs/adr/0013-read-only-enforcement.md)

Four layers, every one of them `pd`'s own code:

| # | Layer | Stops |
| --- | --- | --- |
| a | Generation filter `include: ['/^GET /']` on **both** jobs | A write function existing to be called |
| b | Non-GET refusal inside the custom `fetch` | A write assembled by hand inside the wrapper |
| c | ESLint `no-restricted-imports` on `**/generated/**` outside the client module | A call site reaching the SDK directly |
| d | CI gates on generated output and call sites, failing hard | (a) or (b) silently disappearing |

Layer (b) is not redundant with (a): the generated functions accept a per-call `fetch` and `baseUrl`
spread after `url`, so a wrapper bug can construct a request layer (a) never sees. Layer (b) inspects
the request the runtime is about to issue, not the argument it was handed, and sits **before** the
network call — so when it fires, no write reached Pipedrive.

If it fires, the error is `write_blocked`, exit 1, `retry: never`, `details` carrying method and
resolved path, with a message stating this is a bug in `pd` and not a usage error.

Read-only is scoped to the **Pipedrive API**. `pd cache clear` deletes local files and that is not a
violation; the manifest carries `read_only: true` beside `read_only_scope: "pipedrive_api"`.

### 4. Authentication — [ADR-0012](../../docs/adr/0012-authentication-and-credential-resolution.md)

- API token in the `x-api-token` header. **No OAuth, ever** — Pipedrive offers Authorization Code
  flow only, which would require every user to register a Marketplace application.
- Precedence, first match wins: `--token-file <path>`, then `PD_API_TOKEN`, then
  `$XDG_CONFIG_HOME/pd/credentials` (default `~/.config/pd/credentials`, mode `0600`,
  `%APPDATA%\pd\` on Windows). Otherwise `auth`, exit 1, with a message naming every tier searched.
- **No `--token <value>` flag in any form** — argv is world-readable. Consequently no argument value
  `pd` accepts is sensitive, and usage errors may echo the offending argument back.
- **A `--token-file` that yields no token is `usage`, exit 2, and never falls through**
  ([ADR-0022](../../docs/adr/0022-credential-resolution-edge-cases.md) §1). Falling through to
  `PD_API_TOKEN` is the wrong-account accident the tier order exists to prevent. An absent or empty
  tier-3 file is *not* this case: nobody named it, so the chain continues and ends at `auth`, exit 1.
- **An environment variable that is empty or whitespace-only is unset** (ADR-0022 §2), for
  `PD_API_TOKEN` and for the four directory variables alike.
- **`pd` never writes a credential.** No `login`, no `logout`, no keychain tier, no `Bun.secrets`.
  Tier 3 is a file a human writes with an editor. Loose permissions produce one `warning` and the run
  continues.
- **No named profiles**, no `--profile`, no `PD_PROFILE`. The cache is already keyed by credential
  hash, which is what profiles were wanted for.
- **No store-time validation.** `GET /users/me` stays out of the generated surface; a bad token
  surfaces as `auth` on the first real command.
- `pd auth status` makes zero requests and writes nothing. It emits one JSON object:
  `found`, `tier`, the file path where applicable, `fingerprint` (first 16 hex of SHA-256 of the
  token — the same value the cache directory uses), `cache_dir_exists`,
  `credential_is_write_capable` (a constant `true` whenever a credential is found, because it is a
  statement about the mechanism), and `warnings`. Finding no credential exits 0.

### 5. Output format — [ADR-0002](../../docs/adr/0002-output-format.md), [ADR-0003](../../docs/adr/0003-pagination-bounding-and-partiality.md), [ADR-0006](../../docs/adr/0006-validation-placement-and-rejection.md)

NDJSON is the only machine format. One JSON value per line, each carrying `type` ∈ `record`,
`warning`, `summary`, `error`. Records carry `record_type` in the singular (`"deal"` for
`pd deals list`).

A run ends with **exactly one** trailer, either a `summary` or an `error`, never both. **The last
line always carries `complete` and `emitted`**, whatever its type.

```json
{"type":"summary","complete":true,"emitted":40000,"skipped":3,"duplicates":0,"resolved":"off","requests":80}
{"type":"summary","complete":false,"emitted":100,"skipped":0,"duplicates":2,"resolved":"full","requests":4,"reason":"limit"}
{"type":"error","code":"rate_limited","message":"Burst limit exceeded and retries were exhausted.","exit_code":3,"retry":"after","retry_after_seconds":4,"complete":false,"emitted":3200,"skipped":0,"duplicates":0,"resolved":"off","requests":9,"details":{}}
{"type":"warning","kind":"record_rejected","resource":"deal","id":4711,"path":"person_id","issue":"invalid_type","message":"Expected int, received null."}
```

- `emitted` counts `record` lines written, nothing else. `skipped` counts records zod rejected.
  `duplicates` counts records suppressed by cross-page deduplication. All are always present,
  including on a `usage` error, where all four are zero.
- `reason` appears only on a bounded `summary`; its value set today is the single value `"limit"`.
- `resolved` is `off` / `partial` / `full`, always present.
- **Nothing validates output at runtime.** Line shapes are TypeScript types. The prototype sample
  files are the normative examples and the only guard against drift.
- `--pretty` switches to an aligned human table with no JSON in it, buffered to compute column
  widths. It is explicitly unstable, has **no machine-readable error object at all** (only the stderr
  line), and an agent must never invoke it.
- **Non-NDJSON stdout, by name**: `--help`, `pd manifest`, `pd auth status`, `pd cache info`,
  `pd docs`, `pd --version`. Every one is surface introspection or prose, not a record stream.

### 6. Streaming and internal composition — [ADR-0004](../../docs/adr/0004-streaming-and-result-composition.md)

- A paginated read is `AsyncGenerator<Result<Page, PdError>>`. A `Page` carries validated,
  deduplicated, bounded records, its own warnings, its duplicate count, and `bound` on the final page
  only.
- The generator owns validation, deduplication and the bound; nothing downstream re-filters. It keeps
  no running total — `bound` rides on the page so there is exactly one cumulative record count in the
  process.
- A page is **atomic**: either an `Ok` page or a terminal `Err`, never a partial page.
- The bound must not lie: a limit that fills exactly at a page boundary with a `null` cursor reports
  `complete: true`; a limit that fills where the cursor continues reports `complete: false`, even if
  the next page would have been empty. The conservative error is deliberate.
- One `NdjsonWriter` is the only thing that writes to stdout. It owns `emitted`, `skipped`,
  `duplicates` and warning deduplication, writes the single trailer, and refuses a second call. A run
  that exits with no trailer is a bug and surfaces as `internal`.
- The walk never sees a retryable failure — retry, backoff, the 429 inference and the Cloudflare stop
  all live beneath it. If any of them appears in the page loop, locked point 7 is violated.
- `collect` exists as the specified non-streaming path for any command needing whole-set
  post-processing. It reuses the same writer, and on failure emits `emitted: 0` and writes none of
  the records it holds, because half of a sorted list is a wrong answer rather than a partial one. No
  command uses it yet; any that does is marked `delivery: "collects"` in the manifest.

### 7. Validation placement — [ADR-0006](../../docs/adr/0006-validation-placement-and-rejection.md), [ADR-0029](../../docs/adr/0029-the-record-interior-passes-through.md)

**Amended 2026-08-17.** ADR-0029 narrowed the second stage to a record's *identity* and reversed the
stripping rule. Where this section and that ADR disagree, the ADR governs; the differences are marked
below. Everything about the **envelope** stands as written.

Two stages, failing differently:

| Failure | Class | Result |
| --- | --- | --- |
| Body is not JSON | structural | `Err(invalid_response)`, walk ends |
| `data` absent or not an array | structural | `Err(invalid_response)`, walk ends |
| `next_cursor` present with a wrong type | structural | `Err(invalid_response)`, walk ends |
| An element of `data` carries no readable identity | per-record | `warning`, `skipped += 1`, walk continues |

- *(ADR-0029 §5)* The per-record row above read "fails the record schema". A record's interior is now
  carried, never read, so only a missing identity — an integer `id`, or a string `field_code` on the
  `fields` sources — can reject one.
- *(ADR-0029 §6, reversing this rule)* **Unknown keys are emitted.** A `record` line carries whatever
  Pipedrive sent, so a new Pipedrive field appears with no release. The cost is that a key can be
  emitted and still not be `--fields`-selectable, because the vocabulary comes from the vendored spec.
- **One protected exception**, now moot but still true: `custom_fields` is
  `z.record(z.string(), z.unknown())` and no patch may close it.
- **A first page whose non-empty `data` yields zero survivors is `invalid_response`**, exit 1. No
  later page ever escalates, and there is no ratio threshold — old records cluster on early pages
  under keyset-like cursors, so a wholly rejected later page is the survivable case.
- **`warning` lines are deduplicated by cause** — `(resource, field path, zod issue code)` — while
  `skipped` counts every record. The writer stops emitting after 50 distinct causes and keeps
  counting.
- `path` on a warning is record-relative (`person_id`, never `data.7.person_id`), because an index
  would leak the page and would make identical causes look distinct.
- `id` on a warning is best-effort and **omitted** when unrecoverable, never `null`.
- Cached data is validated on read in the same two stages, against the **same** gate the network path
  uses, so `--no-cache` cannot change what `pd` accepts.
- There is no `--no-validate`.

### 8. Command surface — [ADR-0009](../../docs/adr/0009-command-surface-and-manifest.md), [ADR-0017](../../docs/adr/0017-search-and-list-filtering.md)

Grammar: `pd <resource> <verb> [arg] [flags]`. Three verbs: `list`, `get`, `search`.

**Ten resources**: `deals`, `persons`, `organizations`, `activities`, `products`, `pipelines`,
`stages`, `users`, `fields`, `items`.

- `list` and `get` exist wherever v2 offers the paths. `items` has **neither** — `/itemSearch` has no
  by-id path and no unfiltered listing — so `pd items list` and `pd items get 42` are unrecognised
  constructions, exit 2.
- `search` exists on `deals`, `persons`, `organizations`, `products` and `items`.
- For the four cached resources — `users`, `fields`, `pipelines`, `stages` — `get` filters the cached
  list and reports `requests: 0` on a warm cache.
- `fields` is the one resource whose id is not an integer:
  `pd fields get --entity deal <field_code>`. `pd fields list --entity <name>` requires `--entity`,
  one of `deal`, `person`, `organization`, `product`, `activity`; omitting it is exit 2.
- **Pipedrive's nouns win.** `persons`, not `people`. No aliases, no synonyms, no short flags.
- **Outside the grammar, by name**: `pd manifest`, `pd cache info`, `pd cache clear`,
  `pd auth status`, `pd docs`. These are the complete set; the grammar governs resources, and none of
  these is one.
- Root `--help` opens with the read-only statement and splits into `RESOURCES` and `OTHER`.
- An unrecognised command exits 2 and says `pd` has no write commands at all, pointing at
  `pd manifest`. The message must **not** claim the only verbs are `list` and `get`.

**Global flags — nine, by name**: `--pretty`, `--no-cache`, `--max-requests <n>`, `--limit <n>`,
`--resolve`, `--resolve-budget <n>`, `--token-file <path>`, `--verbose`, `--fields <a,b>`.
The table is flat with no per-command overrides; the manifest says where each applies.

**Command-scoped list filters**: `--ids`, `--owner-id`, `--person-id`, `--org-id`, `--deal-id`,
`--pipeline-id`, `--stage-id`, `--status`, `--done` / `--not-done`, `--updated-since`,
`--updated-until`, `--sort-by`, `--sort-direction`, `--filter-id`. `lead_id` is dropped — leads are
out of scope.

**Command-scoped search flags**: `--exact`, `--search-in <a,b>`, `--types <a,b>` (`pd items search`
only), `--person-id`, `--organization-id`, `--status` (`pd deals search`).

- `--filter-id` with `--ids` is a usage error, exit 2, offline — the API silently ignores `ids` when
  `filter_id` is present.
- `--sort-by` / `--sort-direction` on a search command are usage errors, exit 2.
- Minimum search term length is enforced offline: two characters, or one with `--exact`.
- `--limit` does not exist on non-list commands; passing it is a usage error, not a silent no-op.
- Timestamp flags take RFC3339 verbatim and are validated offline.

### 9. Pagination and bounding — [ADR-0003](../../docs/adr/0003-pagination-bounding-and-partiality.md), [ADR-0018](../../docs/adr/0018-related-entity-expansion.md)

- Page size is internal and fixed at the endpoint maximum: 500 for list and entity search, **100 for
  `/itemSearch`**. The walker reads the ceiling per endpoint.
- `--limit <n>` is a **record count**, never a page size. Positive integer, no upper bound. There is
  no `--max-pages` and no `--all`.
- **The default is everything.** An unbounded run writes a stderr warning on crossing 10,000 emitted
  records and every subsequent 10,000. Not configurable.
- **There is no resumption token.** A cursor of undocumented, keyset-like stability cannot promise
  one; a silent missing record is worse than a re-run.
- Deduplication holds every id seen for the whole run with no cap and no sliding window. On search it
  is keyed `(record_type, id)`, so deal 42 and person 42 do not collide in `pd items search`.
- `--ids` accepts any number of ids, deduplicates them, and chunks into requests of at most 100 in
  the caller's order. The chunk boundary is unobservable. Fewer distinct ids returned than named
  produces one `unmatched_ids` warning, exit 0, `complete: true`.

### 10. Resolution — [ADR-0007](../../docs/adr/0007-the-narrow-v1-users-client.md), [ADR-0008](../../docs/adr/0008-resolution-mechanics.md)

One flag, `--resolve`, covering custom-field hashes, enum and set option labels, owner ids and
relations. Always **additive**: raw values survive byte-identical.

- Seven standard pairs: `owner_id`→`owner_name`, `creator_user_id`→`creator_user_name`,
  `user_id`→`user_name`, `person_id`→`person_name`, `org_id`→`org_name`,
  `pipeline_id`→`pipeline_name`, `stage_id`→`stage_name`. **An unresolvable id omits its sibling
  key** — not `null`, not the id as a string.
- Custom fields resolve into a parallel `custom_fields_resolved` block keyed by hash, holding `name`
  and, where meaningful, `label`. Keying by hash dissolves the duplicate-display-name problem
  permanently.
- Resolvable types: `enum` / `set` (option label from the cached schema), `user` (cached list),
  `person` / `organization` relations (batched `ids` fetch), `monetary` (`"12000.00 EUR"`),
  `address` (comma-joined). `date`, `varchar`, `text`, `double` get a `name` and no `label`.
- Resolved values are formatted neutrally — no thousands separators, no locale decimal mark, no
  timezone conversion, no currency symbol substitution.
- `include_option_labels` is **never sent**: it replaces the raw value rather than adding to it, and
  its coverage is partial.
- Relation ids are batched **per page**, 100 per request, with a run-scoped id→name map. Buffering
  the whole walk would silently convert a streaming read into a collected one.
- Fixed-cost half: at most four requests on a cold cache (the entity's field schema, `users`,
  `pipelines`, `stages`), zero warm. Variable-cost half: relation batches, ceiling **50 requests by
  default**, `--resolve-budget <n>`.
- **Enrichment yields to `--max-requests` and never trips it.** A batch is dispatched only if the
  remaining headroom survives it; otherwise resolution stops as if the resolve budget were spent.
- **Every failure degrades**: one `warning`, raw ids for the rest of the run, `resolved: "partial"`,
  exit 0. The asymmetry is deliberate — a `users` fetch failure degrades under `--resolve` but is
  fatal to `pd users list`, where the list is the answer rather than a decoration.
- An unrecognised 40-character hex key forces **one** blocking schema refresh per schema per run;
  after that, unknown hashes are emitted raw with one `unknown_custom_field` warning.
- On search commands `--resolve` is accepted and resolves owner ids only, at zero requests.

### 11. Field projection — [ADR-0016](../../docs/adr/0016-field-projection.md)

- `--fields <name>[,<name>…]`, repeatable and accumulating, duplicates deduplicated. No negation, no
  wildcards, no `--exclude`.
- **`id` is always emitted**, along with `type` and `record_type`.
- Selector grammar: a bare top-level name, or `custom_fields.<hash>`. No deeper dotting. `prices` on
  a product is selectable whole, and no path reaches inside it.
- **A display name is never a legal selector.** `pd fields list --entity deal` is how a human learns
  a hash.
- **A resolution artifact rides with its raw field and is never selectable alone.**
  `custom_fields_resolved`, `org_name` and its six siblings are not legal selectors; naming one is a
  usage error whose message names the raw field instead. This buys the invariant that **the legal
  selector set does not depend on `--resolve`.**
- Projection removes fields, never records. A record whose every selected field is absent still
  emits as `{"type":"record","record_type":"deal","id":42}`.
- An unknown top-level name is exit 2 **offline**, listing the valid names. A syntactically valid
  hash matching zero records across the whole run is one `unmatched_field_selector` warning.
- Key order in machine mode is the order Pipedrive sent (ADR-0029 §8 — it was `pd`'s schema order
  until a record stopped being reconstructed); under `--pretty` it is selector order. Either way the
  selectors' own order never reaches the output.
- **Push-down**: the upstream `custom_fields` query parameter (max 15 keys, available on deals,
  persons, organizations and products) is sent when every condition holds — the endpoint offers it,
  every custom-field selector is a hash, bare `custom_fields` was not selected, and the count is ≤ 15.
  Otherwise `pd` fetches whole records and trims locally. **Output is byte-identical either way**, so
  this is an optimisation and never a contract difference.
- **`include_fields` is never sent.** It is additive, not subtractive; its namespaces are outside
  `pd`'s record schema.
- Projection happens after zod validation and before the resolve prefetch, so it shrinks
  `--resolve-budget` consumption as a side effect.
- The single-JSON-object commands reject `--fields` as a usage error rather than ignoring it.

### 12. Value formatting and absence — [ADR-0020](../../docs/adr/0020-value-formatting-and-absence.md)

- Money is a **JSON number**; `currency` stays a flat sibling. Same for `arr`, `mrr`, `acv`, which
  are read in the deal's `currency`. Folding the pair into an object would create a block the
  selector grammar cannot name.
- **Time passes through byte-for-byte and is never parsed.** The v2 spec declares these fields as
  bare `type: string` with no `format`, so there is nothing to normalise to.
- `due_date` and `due_time` stay two fields. `expected_close_date`, `due_date` and `due_time` are
  account-local wall clock, and `pd` says so rather than interpreting them.
- **The account timezone is never read.**
- **A field with no value is an absent key.** Only `null` and absent are absent — `[]`, `""` and `0`
  are values. `custom_fields` is exempt and stays byte-identical passthrough (`{}` when empty).
  `id` is never absent.
- `products.prices` is the one nested block in the contract, kept as an array of objects. Money
  inside it follows the same rule, and omission applies inside those objects too.
- `--fields` on an empty field yields a shorter line, not a warning.
- `weighted_value` **does not exist** in the v2 API. `pd` neither emits nor computes it.

### 13. Cache — [ADR-0005](../../docs/adr/0005-cache-design.md), [ADR-0008](../../docs/adr/0008-resolution-mechanics.md) §6, [ADR-0010](../../docs/adr/0010-budget-guard.md) §7

A closed list of **eight** entries and nothing else. No entity records, no result sets, no search
results.

| Entry | TTL |
| --- | --- |
| `users` | 1 h |
| `dealFields`, `personFields`, `organizationFields`, `productFields`, `activityFields` | 24 h |
| `pipelines`, `stages` | 24 h |

The rule is: **every v2 `*Fields` schema is cached for 24 hours.** `projectFields` is excluded only
because projects have no command surface.

- Keyed by **credential**: `$XDG_CACHE_HOME/pd/<token-hash>/`, default `~/.cache/pd/`,
  `%LOCALAPPDATA%\pd\<token-hash>\` on Windows. `<token-hash>` is the first 16 hex of SHA-256 of the
  resolved token. Keying by a user-invented profile name would silently poison a repointed
  credential's cached schemas.
- Beyond TTL, an unrecognised 40-hex key or an unknown `owner_id` forces one refresh.
- A cache hit does **not** count against `--max-requests`, which therefore means **network requests**.
- A broken entry is skipped, refetched, and reported as a `cache_entry_skipped` warning — on stdout
  in machine mode, stderr under `--pretty`. Never fatal, never silent.
- Mechanics: temp file plus `rename`, `0600`, a schema version per entry (an unrecognised version is
  treated as missing), no credential ever written.
- `--no-cache` skips the read and still writes, so one run restores the normal path.
- `pd cache info` reports path, entries, ages and the sentinel. `pd cache clear` deletes the subtree
  **minus the `blocked` sentinel**, with no path argument, no pattern and no widening flag.

### 14. The budget position — [ADR-0010](../../docs/adr/0010-budget-guard.md)

**`pd` does not guard the shared daily budget, and says so.** Every input a guard would need is
unreadable: no header reports the remaining pool, v2 reports no total count so a walk cannot be
sized, and the denominator (`30,000 × plan multiplier × seats`) is not reported anywhere. There is no
floor, no daily token ceiling, no cross-invocation ledger.

The arithmetic behind accepting that: the heaviest single run `pd` can produce is roughly 1,300
tokens against a smallest-possible pool of 30,000. A single run is structurally incapable of being
the problem; a runaway loop is, and no honest number bounds it.

`--max-requests <n>` is the only quantitative guard, counts network requests, and **has no default**.

**One piece of cross-invocation state exists**, and it is a Cloudflare question rather than a budget
one: on a `blocked` outcome, `pd` writes a sentinel under the credential's cache directory. While it
is live, every invocation for that credential refuses immediately with zero HTTP requests, `blocked`,
exit 3. It expires after **15 minutes**. There is no override flag; `pd cache clear` preserves it and
`--no-cache` does not bypass it. Only the expiry and a human deleting the file remove it. An
unparseable sentinel is treated as absent.

### 15. Error model — [ADR-0001](../../docs/adr/0001-error-model-and-exit-codes.md), [ADR-0013](../../docs/adr/0013-read-only-enforcement.md)

**Twelve variants**, each earning its place by a distinct caller response:

| Variant | Exit | `retry` | When |
| --- | --- | --- | --- |
| `usage` | 2 | never | Bad argument, unknown command |
| `auth` | 1 | never | Credential missing, invalid or revoked |
| `forbidden` | 1 | never | Credential valid, permission insufficient |
| `not_found` | 1 | never | The named single resource does not exist |
| `invalid_response` | 1 | never | Pipedrive returned data the schema rejects |
| `internal` | 1 | never | A programmer error that escaped |
| `write_blocked` | 1 | never | The runtime guard refused a non-GET — a bug in `pd` |
| `upstream` | 1 | after | 5xx or transport failure after retries |
| `rate_limited` | 3 | after | Burst window exhausted, retries spent |
| `request_ceiling` | 3 | never | `--max-requests` reached |
| `budget_exhausted` | 3 | not_today | Shared daily pool gone, or a 429 that cannot be attributed |
| `blocked` | 3 | not_today | Cloudflare block on the company's traffic |

- `code`, `message`, `exit_code` and `retry` are on **every** error. `retry_after_seconds` appears
  only when `retry` is `after`. `emitted` reports records written before the failure.
- **An ambiguous 429 is `budget_exhausted` and stops.** `pd` attempts the inference —
  `x-ratelimit-remaining` above zero implies the daily pool rather than the burst window — but when
  the inference is unavailable it chooses the cautious variant, because the opposite mistake blocks
  the whole company.
- `not_today` is a distinct `retry` value rather than a large countdown, because the daily reset is
  "midnight at server's timezone" and the server timezone is named nowhere.
- `details` is **explicitly unstable**, may never be branched on, and has URLs redacted before entry —
  a request URL carries search terms and filter values, which are company data.
- Cache corruption is not a variant: `pd` evicts and refetches. A list with no matches is an empty
  success, not `not_found`.
- **Stability**: the four always-present fields, the meaning of each exit code, and the meaning of an
  existing `code` are frozen. Adding a `code` is non-breaking, which is only safe because `retry` is
  always present. The error object carries no version number.

**Eight warning kinds, by name**: `record_rejected`, `cache_entry_skipped`,
`owner_resolution_unavailable`, `unknown_custom_field`, `resolution_budget_exhausted`,
`unmatched_field_selector`, `unmatched_ids`, `credential_file_permissions`.

`credential_file_permissions` is the eighth, minted by implementation ticket 03 for the two
permission statements about the credential file that ADR-0012 §3 and ADR-0021 §8 require and that no
ADR named a `kind` for: a POSIX file with permissions looser than `0600`, and the Windows NTFS gap
where `0600` has no equivalent. Both say the same thing about the same file, so they share one kind.
`src/lib/warnings.ts` is the registry; this list is a copy of it.

### 16. stderr and diagnostics — [ADR-0015](../../docs/adr/0015-stderr-and-run-diagnostics.md)

**In machine mode, nothing on stderr is the sole carrier of any fact.** That invariant is what makes
the channel safe to use at all, given that agent harnesses treat it inconsistently.

- Default stderr is exactly two things: the one-line error summary, and the per-10,000-record warning
  on an unbounded run. A successful bounded run is byte-silent.
- Progress is **TTY-gated on stderr's own descriptor**. Accepting environment-dependent behaviour is
  legitimate here precisely because stderr is declared not a contract.
- **stderr is prose and is not a contract.** No JSON, no `type` tag, no stable wording, no
  `--log-format`. If telemetry is ever wanted, the answer is "there is none".
- One `\r`-rewriting status line at about 1 Hz (records, requests, elapsed), plus permanent appended
  anomaly lines for gate pauses, 5xx backoffs, the self-raising ceiling, cache skips and the
  10,000-record warning. A final summary replaces the status line and reports no token cost.
- `--verbose` forces everything on regardless of TTY and adds a per-request line: method, path,
  redacted query, status, duration, attempt number, cache hit. No `-v`, no `--quiet`, no level scale,
  no environment variable. **It never changes a byte of stdout.**
- **Redaction is allowlist-based in both directions.** Query values print only for
  `limit`, `cursor`, `sort_by`, `sort_direction`, `include_option_labels`, `ids`, `custom_fields`,
  `exact_match`, `item_types`, `fields`, `status`, `person_id`, `organization_id`, `owner_id`,
  `org_id`, `deal_id`, `pipeline_id`, `stage_id`, `done`, `filter_id`, `updated_since`,
  `updated_until`. Everything else prints its name with `[redacted]`. **`term` is refused
  permanently.** Headers print from an allowlist — `x-ratelimit-limit`, `x-ratelimit-remaining`,
  `x-ratelimit-reset`, `retry-after`, `content-type` — and `x-api-token` cannot be added. **Response
  bodies are never logged at any verbosity.** Path segments including ids print whole.

### 17. Search normalisation — [ADR-0017](../../docs/adr/0017-search-and-list-filtering.md)

A search hit is **not** a record. It is a truncated projection plus `result_score`, and `pd` owns the
four hit schemas outright.

- `record_type` is `deal_search_hit`, `person_search_hit`, `organization_search_hit` or
  `product_search_hit`. Never `deal`.
- The `item` object is **flattened into the record body**, with `result_score` as a top-level sibling,
  so `--fields id` means the same thing on `search` as on `list`.
- Normalisations: `type` is dropped (it collides with the line kind); `owner: {id}` becomes
  `owner_id`; `stage`, `person` and `organization` objects become the `*_id` / `*_name` pairs already
  defined; `custom_fields: string[]` becomes **`matched_custom_field_values`**; `notes: string[]`
  becomes **`matched_notes`**. The two renames are the only places a Pipedrive field name is not
  carried through, and they exist so that no JSON path holds two types.
- A hit carries `stage_name`, `person_name` and `org_name` **without `--resolve`**, because the API
  supplied them. The shape does not change with the flag, which is the invariant that matters.
- `item_types` is pinned to `deal,person,organization,product` on every request and never defaulted,
  so `itemSearch` cannot re-admit leads. `--types` narrows within that set only.
- `/leads/search` and `/itemSearch/field` get no command.
- `search_for_related_items` is refused: its `related_items` are hits rather than records, it returns
  leads, and it truncates at "100 newest" with no marker.
- Search shares `--max-requests` and gets no ceiling of its own, because its requests are the ones the
  caller asked for — the asymmetry with `--resolve-budget`, whose requests are implicit.

### 18. Related-entity expansion — [ADR-0018](../../docs/adr/0018-related-entity-expansion.md)

**There is none.** No `--expand`, no `--include`. `--resolve` stays legibility, not data. A `record`
line never carries another entity's record.

The answer is two commands, documented in `AGENTS.md` as a recipe rather than as an apology:

```
pd deals list --fields title,org_id        # → org_id 7, 9, 11 …
pd organizations list --ids 7,9,11         # → the whole organisation records
```

The fact that decided it: `ids` is a parameter on the **same operation** as the unfiltered list, so
the second command issues exactly the request an in-run expansion would have issued. **Request cost
against the shared budget is identical either way**, which removes expansion's only real argument and
leaves it paying five contract questions for one saved invocation.

### 19. Distribution — [ADR-0021](../../docs/adr/0021-distribution-build-from-source.md)

*Supersedes [ADR-0014](../../docs/adr/0014-distribution.md) in full. There is no npm package, no Node
target and no `unsupported_runtime` variant.*

- **One channel: this repository.** `git clone` → `bun install` → `bun run build` → `dist/pd`
  (`dist\pd.exe` on Windows), a compiled `bun build --compile` binary. No registry, no release
  artifact, no installer, no Homebrew, no code signing, no notarization, no platform matrix.
  Notarization is not needed because a locally built binary carries no `com.apple.quarantine` xattr —
  that xattr, set by the downloader, is what SIGKILLs an unsigned binary.
- **No install script.** `bun run build` writes into the checkout and stops. Putting `dist/pd` on
  `PATH` is the user's business, and `pd` ships no code that writes outside its own checkout.
- **Bun is the only runtime**, at build time and at run time — the binary embeds it, so the host needs
  nothing. `Bun.*` and `bun:*` are permitted in `src/**`, and the ESLint ban is removed. Two
  temptations stay refused on their own grounds: `Bun.secrets` (no `login` command puts anything in a
  store) and `bun:sqlite` (a relative database path resolves against the process CWD).
- **The build command is normative, and two flags are a safety property:**
  `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Without them a compiled binary
  auto-loads `.env` from the process CWD, so a repository the agent happens to stand in can set
  `PD_API_TOKEN` and win tier 2 of the credential chain from outside it. A CI gate asserts the
  property against the built binary. `--minify --bytecode` is kept on measurement: 21.5 ms startup
  against 27.1 ms, for +2.9 MB.
- **Everything the binary needs is embedded**, `AGENTS.md` included: `pd docs` writes the embedded copy
  and never reads from disk, the executable's directory or the CWD.
- **`pd --version` reports the commit**, because every binary is built from whatever commit its builder
  had: `1.0.0` at a clean tag, `1.0.0+g3f9a1c2` off a tag, `1.0.0+g3f9a1c2.dirty` with local changes.
  The base is `package.json`'s version, stamped through `--define`; the suffix is semver build
  metadata and does not affect precedence.
- **`pd` never checks for a newer version of itself.** There is no registry to poll. Updating is
  `git pull && bun run build`.
- Semver MAJOR is defined against the agent-visible contract — a line shape, a `type` tag, a trailer
  field, an exit code, a `code` string, or a command changing or disappearing — and `manifest_version`
  moves in lockstep. A new field on an existing line is MINOR, and that cost is named rather than
  hidden. First release from this spec is `1.0.0`.
- Windows is supported by the same source path with `%LOCALAPPDATA%` / `%APPDATA%`, and the NTFS
  permission gap is stated in `pd auth status` warnings rather than papered over.
- **The repository stays private, and is therefore also the audience boundary.** `pd`'s users are
  whoever has a clone — colleagues, and harnesses under their credentials. They already hold a
  write-capable Pipedrive token, so the fixture tree shows them nothing they cannot read live.

### 20. The manifest — [ADR-0009](../../docs/adr/0009-command-surface-and-manifest.md) §10, [ADR-0016](../../docs/adr/0016-field-projection.md) §8

`pd manifest` is a subcommand emitting **one JSON object**, not a flag and not a committed file. It
carries:

- `manifest_version` (integer, moves only on a breaking change) and `pd_version` (release string)
- `read_only: true`, `read_only_scope: "pipedrive_api"`
- commands split into resource commands and the named exceptions, with per-command arguments, flags,
  the `--fields` selectable-field list, and `delivery: "streams" | "collects"`
- the global flag table, with `--pretty` marked `machine_readable: false` and carrying the
  instruction never to invoke it from an agent
- the vocabularies an agent must branch on: `type` line kinds, warning `kind` values, the `resolved`
  values, exit codes 0/1/2/3, and the full `code` union with its exit-code and `retry` mapping
- the trailer fields `complete`, `emitted`, `skipped`, `duplicates`, `resolved`, `requests`
- the output format, declared **once globally** as NDJSON
- `--filter-id` marked `"enumerable": false`, because `pd` has no command that lists filter ids

It must **not** express a per-command request cost — `pd users get 42` legitimately costs zero
requests on a warm cache.

Custom-field hashes are not in the manifest: they are per-account and `pd fields list` serves them.

The manifest and every `--help` text are generated from one in-code command table, so they cannot
drift.

---

## Testing Decisions

Normative: [ADR-0019](../../docs/adr/0019-testing-strategy.md). **No new seam is proposed. The seams
below are ADR-0019's, and it added exactly two injected dependencies and one injected predicate to
production code.**

### What makes a good test here

A good test asserts something a caller can observe: the bytes on stdout, the exit code, the number of
network dispatches, the contents of a trailer. It does not assert that a particular function was
called, that a page loop iterated a particular number of times, or that an internal type has a
particular shape — `Page` is internal and adding a field to it is not a breaking change, while adding
a field to a trailer is.

The design makes this cheap on purpose: the record schema, the line grammar and the four search-hit
shapes are all `pd`'s own, so almost the entire agent-visible contract is testable without a network.

### The seams

1. **`guardedFetch`** — the one custom `fetch` every request from both generated clients passes
   through. Fixture replay is installed here, and the replay layer sits **below** ADR-0013's non-GET
   refusal, so no test can test its way past the read-only property; every replay test is also
   another execution of the refusal path. It is also the single answer to every ADR's "and no request
   was made" assertion: *how many dispatches did the gate record?*
2. **One injected `Clock`** (`now()` and `sleep()`) on the same module that already takes the injected
   transport. It covers six timing behaviours — the 2-second gate, the three-strike 429 pause, the
   jittered 5xx backoff, the ~1 Hz status line, the 24 h / 1 h cache TTLs, and the 15-minute `blocked`
   sentinel. The retry test alone costs about six real seconds without it and the TTLs are untestable
   at all. Jitter is seeded from the same source, so backoff tests assert exact durations.
3. **One injected TTY predicate** on the diagnostics module, for ADR-0015 §1's "a non-TTY run emits
   exactly two things on stderr".

Nothing else. No `--state-dir`, no `PD_TEST_HOME`, **no test-only flag or environment variable of any
kind**. Isolation runs on the `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` and Windows paths that already
exist — which is how a test places the `blocked` sentinel without making it settable by an agent.

### Layers, and the blind spot of each

| Layer | Catches | Cannot catch |
| --- | --- | --- |
| **Offline** — no gate, no fixtures | flag parsing, the selector grammar, error mapping and exit codes, bounding arithmetic, trailer counters, dedup keys, `--ids` chunking | anything about a response body; a wrong `next_cursor`; that the operation exists |
| **Fixture replay at `guardedFetch`** | the whole walk: pagination, validation and rejection, resolution, projection, search normalisation, the streaming and trailer contract, timing under the fake clock | Pipedrive changing — a fixture is a photograph |
| **Live suite**, hand-invoked | Pipedrive changing: a widened hit projection, a renamed field, a new enum, a moved operation | nothing on a schedule; and never a retry, a 429 or the Cloudflare block, permanently |

Replay is **strict**: no passthrough, and a request with no matching fixture is a test failure. The
default gate is constructed with a transport that **throws**, so zero requests per `bun test` is
mechanical rather than disciplinary — forgetting to record a fixture fails the test that needed it,
on the developer's own machine. Fixtures are keyed by method, path and the sorted query parameters
`pd` actually varies.

The replay store is **not** the cache. The cache is deliberately partial, deliberately stale, TTL'd,
version-stamped and credential-keyed; a fixture store must hold record responses, never expire, not
care which credential recorded it, and be keyed by request. They are permitted to fail in opposite
directions, so they stay separate — fixtures under version control, the cache in the user's cache
directory, never committed.

### Mandatory assertions

Each exists because another decision requires it. Their shape is negotiable; their existence is not.

| Source | Assertion | Layer |
| --- | --- | --- |
| ADR-0013 §2 | Both generated clients contain zero non-GET operations after regeneration | CI gate |
| ADR-0013 §2 | ESLint `no-restricted-imports` on `**/generated/**` | CI gate |
| ADR-0013 §1, §4 | A non-GET driven through the client yields `write_blocked`, exit 1, and dispatches nothing | Unit |
| ADR-0021 §3 | The built binary ignores a `.env` in the process CWD: `pd auth status` beside one setting `PD_API_TOKEN` does not report the `env` tier | CI gate, on the binary |
| ADR-0015 §6 | No unredacted query value and no non-allowlisted header can reach stderr | CI gate |
| ADR-0019 §10 | No credential-shaped string anywhere in the fixture tree | CI gate |
| ADR-0019 §10 | No fixture is embedded in the built binary | CI gate |
| ADR-0015 §1 | A non-TTY run emits exactly two things on stderr, and neither is progress | Replay |
| ADR-0016 §7 | The same projection **with and without** the `custom_fields` push-down is byte-identical | Replay, fixture pair |
| ADR-0016 §6 | An unknown top-level selector exits 2 with zero dispatches | Offline |
| ADR-0017 §6, §7 | Minimum-term refusal, `--filter-id` with `--ids`, `--sort-by` on search — each exit 2, zero dispatches | Offline |
| ADR-0017 §9 | The `(record_type, id)` dedup key on a mixed `pd items search` fixture | Replay |
| ADR-0018 §3 | 250 ids issue exactly three requests; duplicate ids issue the same requests as without them; two omitted ids produce one `unmatched_ids` warning and exit 0 | Replay |
| ADR-0006 §9 | A last page with `next_cursor: null` completes the walk rather than failing the envelope | Replay |

Six of these are CI gates, and four of the six assert a **safety** property — no writes exist, no
write can be issued, no credential leaks to stderr, no credential leaks to the repository. A safety
gate that merely warns is not a gate; all six fail the build.

The projection byte-identity test is the highest-value single test in the design: it is the only thing
standing between an upstream optimisation and a silent contract change, and it needs a fixture
**pair** recorded from the same account state — a recording-time constraint, not a test-time one.

### Prior art for the tests

There is none in this repository yet; `pd` is unimplemented. The nearest existing artifacts are the
sample NDJSON files under `prototypes/10-output-format/`, which ADR-0002 declares the **normative
examples** of the output format and the only guard against shape drift. They currently predate
`skipped` and `duplicates` and must be regenerated before they can serve as fixtures.

### Runtimes and CI legs

The suite runs under **Bun**. A separate short **binary smoke leg** builds `dist/pd` and runs a fixed
set of end-to-end invocations against the binary, on Linux and on Windows. The leg exists because
three things cannot be asserted in source form: version agreement between `pd --version` and the
manifest's `pd_version`, the embedded `AGENTS.md` behind `pd docs`, and that no fixture is embedded.
It also carries ADR-0021 §3's assertion that a `.env` in the process CWD does not reach the credential
chain.

CI runs three legs: the Bun suite plus lint and the gates; the binary smoke leg on Linux; the same leg
on Windows, whose whole purpose is the `%LOCALAPPDATA%` / `%APPDATA%` resolution that is the only
Windows-specific code in `pd`.

### The live suite

A separate suite and a separate command, never in CI, never on a schedule, never part of `bun test`.
It runs against a **real production account** — a sandbox would pin a schema no user of `pd` will ever
meet — read-only by construction through the same guarded client, and it is the only place in the
project that supplies a `--max-requests` ceiling by default.

**Its output is a re-recording and a git diff, not a pass or fail.** A diff touching only values is
noise; a diff touching keys is Pipedrive changing under `pd`, and that is the signal.

**It never tests a retry path, a 429, or the Cloudflare block. Permanently.** Those are the tests
whose *successful execution* costs the company its API access. They are tested against fixtures with
the injected clock, and nowhere else.

### Fixtures hold real CRM data

Recorded responses are committed verbatim — real deals, real organisation names, real amounts, real
owners. Two consequences are load-bearing rather than incidental:

- **The repository must stay private**, and cannot become public by flipping a setting, because
  fixtures persist in git history. Under ADR-0021 the repository is also the distribution channel, so
  this now bounds who can obtain `pd` at all: its users are whoever already has a clone. Two escapes
  were considered and declined — a second private repository for the fixtures (permanent submodule and
  CI-credential overhead for an audience `pd` does not have) and sanitising fixtures at record time (a
  sanitiser must be trusted on every field forever, and one missed field is public and permanent).
  `.gitignore` is not an escape at all: ADR-0019 §9 defines the live suite's signal as a **git diff**,
  which an ignored directory cannot produce, and untracked fixtures leave CI's no-passthrough replay
  gate with nothing to serve.
- **No fixture is embedded in the binary.** A CI gate asserts it against `dist/pd`, so the separation
  between the private repository and the artifact a colleague builds is enforced rather than
  intended.

The credential is stripped mechanically and separately: the recorder never writes request headers at
all, and a CI gate greps the whole fixture tree for credential-shaped strings.

---

## The two safety properties, traced to mechanism

Ticket 22 requires that neither property be merely asserted. Both trace to named mechanisms.

### Read-only

| Mechanism | Where |
| --- | --- |
| Generation filter emits 66 GETs and zero writes, on both jobs | §3 layer (a), ADR-0013 §1 |
| Non-GET refusal inside the single custom `fetch`, before the network call | §3 layer (b), ADR-0013 §1, §5 |
| ESLint import ban on the generated SDK outside the client module | §3 layer (c) |
| Two hard-failing CI gates | §3 layer (d), Testing §Mandatory |
| A unit test that drives a non-GET through the client and asserts `write_blocked` | Testing §Mandatory |
| The typed `write_blocked` variant telling the caller to stop using `pd` | §15 |
| `pd auth status` stating the token is write-capable, every run | §4 |
| `read_only_scope: "pipedrive_api"` in the manifest, so `pd cache clear` is not a loophole | §3, §20 |

**Honest limit:** nothing outside `pd` enforces any of it. An API token cannot be scoped, so all four
layers are code in one repository reviewed by the same people. A write reaching Pipedrive needs all
three of write-exists, CI-missed and guard-bypassed. The only account-level mitigation is a restricted
Pipedrive permission set on the token's user, and `pd` can only document it.

### The shared daily budget

**`pd` does not guard it, and every document says so.** What exists is pressure reduction and one
company-scale stop:

| Mechanism | Effect |
| --- | --- |
| Burst gate at half the smallest documented window | `pd` never consumes a shared token's whole allowance |
| A 429 pauses the whole gate, not one request | A rate problem becomes at most one 429 per window |
| 3 burst strikes ≈ 6 s, then stop; ambiguous 429 stops immediately | The retry loop that earns a Cloudflare 403 cannot form |
| `blocked` sentinel, 15 minutes, no override, unreachable from `--no-cache` or `cache clear` | A looping agent cannot get fifty fresh retry caps |
| `--max-requests`, reserved before dispatch, retries counted | The one quantitative guard the caller can set |
| Enrichment yields to that guard and never trips it | `request_ceiling` only ever reflects the caller's own query |
| `--resolve-budget`, default 50 requests | Implicit requests cannot surprise the pool |
| Cache of eight near-static entries, keyed by credential | Repeat metadata fetches disappear |
| Page size 500, v2 over v1, `--updated-since` | Fewer requests and fewer tokens per unit of work |
| Zero requests per `bun test`, mechanically | Development cannot spend the pool |
| Live suite hand-invoked only, never scheduled, never testing a 429 | Testing cannot take the CRM offline |

**Honest limit:** nothing in `pd` stops an agent that runs it ten thousand times. Budget stewardship
remains a human's job through Pipedrive's own API Usage Dashboard.

---

## Out of Scope

### Genuinely out of scope — adding any of these reopens a decision

- **Any write operation** — create, update, delete. Not behind a flag, not behind a prompt, not ever.
- **The v1 API except `users`.** Leads, notes, currencies, activity types, filters and the changelog
  are not exposed, even though they are live and v1-only. `users` survives as **one generated
  operation**, `GET /users`; the other seven `users` endpoints are excluded by name.
- **The v2 `include_fields` namespaces** — activity, file and note counts, follower and participant
  counts, mail timestamps, `smart_bcc_email`, `source_lead_id`, `ui_visibility`. The parameter is
  additive rather than subtractive, so requesting a namespace costs response size on every record to
  answer a question `pd` was not built for. Adding one later is additive under semver.
- **Related-entity expansion.** No `--expand`, no nested related records, no deduplicated sibling
  lines. The two-command join is the answer.
- **`search_for_related_items`** and `/leads/search`.
- **OAuth**, named profiles, a keychain tier, `pd auth login|logout|verify`, and any `--token <value>`
  flag.
- **A resumption token**, `--max-pages`, `--all`, `--no-validate`, `--concurrency`, `--quiet`,
  `--log-format`, `PD_LOG`, and any flag that overrides the `blocked` sentinel.
- **A daily token ceiling or remaining-budget floor.** Every input is unreadable.
- **A compiled binary**, curl installer, Homebrew tap, code signing, notarization, platform packages,
  and any self-update check.
- **Structured or parseable stderr.** If telemetry is ever wanted, the answer is "there is none".
- Webhooks. Multi-tenant support. Any UI.
- **Implementing `pd`.** This spec is the artifact; building from it is the next effort.

### Not in the *first* surface — additive later, no `manifest_version` bump

These are not refused, merely not shipped first. Adding one is a MINOR release and does not reopen
anything.

- Resources: `projects` (and their archived variants and templates), `tasks`, `boards`, `phases`,
  `projectTemplates`.
- Deal children: products, discounts, installments.
- Followers, changelogs, and the `archived` list variants.
- `/itemSearch/field` — it returns a third response shape and its `match` modes are an autocomplete
  affordance for a human typing into a box.
- `projectFields` in the cache — excluded only because `projects` has no command. The 24-hour rule
  admits it automatically if that changes.

---

## Further Notes

### The map's fog is empty, and nothing graduated silently

The **Not yet specified** section of [`map.md`](map.md) is empty, with the note that the last fog
patch graduated into ticket 29. Every entry that ever appeared there was resolved by a ticket that
produced an ADR: manifest schema and versioning (ADR-0009), filtering and search (ADR-0017), field
projection (ADR-0016), related-entity expansion (ADR-0018), testing strategy (ADR-0019), value
formatting (ADR-0020). **There is no open design gap this spec has to name.**

Every one of the twenty decision tickets produced an ADR under `docs/adr/`, numbered 0001 to 0020
with no gaps.

### Three contradictions between ADRs, and how this spec rules

Ticket 22 asks for confirmation that no ADR contradicts another. Three do, all cosmetic, all in text
that ships to an agent — so all three need a ruling before implementation, not after.

1. **The `resolved` vocabulary.** ADR-0008 §11 defines `"off"` / `"partial"` / `"full"`. ADR-0009
   §10 lists `none` / `partial` / `full`. **ADR-0008 is the deciding ADR and wins: the value is
   `"off"`.** ADR-0009's manifest section is a mis-citation.
2. **The guard's trailer.** ADR-0003 makes `reason` exclusive to a bounded `summary`, with the single
   value `"limit"`, and makes a `--max-requests` stop an **`error`** trailer carrying
   `code: "request_ceiling"`. ADR-0008 §10 and ADR-0018 §3 both write `reason: "max_requests"`.
   **ADR-0001 and ADR-0003 own the output contract and win: a guard stop is an `error` line with
   `code: "request_ceiling"`, exit 3, and there is no `reason: "max_requests"`.**
3. **`unknown_command`.** ADR-0009 §6 and ADR-0017 §2 both write `code: "unknown_command"`, while
   ADR-0001 lists `usage` as covering "bad argument, unknown command" and ADR-0017's own Consequences
   assert that the error union gains no variant. **ADR-0001 owns the union and wins: an unrecognised
   command is `usage`, exit 2, with the read-only teaching message; `unknown_command` is not a
   `code`.** If a distinct code is genuinely wanted, that is a new decision under ADR-0001's rule
   that a variant must earn its place by a distinct caller response — and here the response is
   identical to any other usage error.

### Counts drift; enumerate instead

Several ADRs state ordinals that were true when written and are now stale — the "eighth global flag"
that is also described as making the table seven, and the "third" and "fourth" stdout exceptions
counted differently in three ADRs. **This spec enumerates by name everywhere and states no total that
is not also a list.** Implementation should do the same, and the manifest — generated from one in-code
table — is what keeps the lists honest.

### Known implementation-time probes

Two questions are deliberately left to be answered with a keystroke rather than an argument:

- Whether `custom_fields=` with an empty value means "none" upstream. If it does, dropping every
  custom field from a large walk is the single largest response-size win available. `pd` does not
  gamble on it today and omits the parameter instead.
- ~~**An eighth `warning` kind must be minted.**~~ **Answered by implementation ticket 03,
  2026-08-13**: the kind is `credential_file_permissions`, and it covers both ADR-0012 §3's
  loose-permissions warning and ADR-0021 §8's Windows NTFS caveat. See the eight-kind list in §15.
- Whether the `parser.patch` hoist of inline v2 response item schemas into `components/schemas`
  works in the per-path form. Only the whole-spec form was verified. The fallback — a hand-written
  three-field envelope schema with generated record schemas — leaves the two-stage validation split
  intact and moves only its plumbing.

### Remaining ticket-22 work, not delivered by this spec

[Ticket 22](issues/22-task-assemble-the-spec.md) lists five deliverables. This spec is the first. Four
remain and are not started here:

1. **`AGENTS.md`** — the canonical documentation file, plus the harness-specific pointer files. Twelve
   ADRs list content it must carry: the grammar and three verbs, the ten resources, the named
   exception groups, the never-`--pretty` sentence, the `--limit` instruction and the fact that the
   10,000-record warning may never arrive, the credential chain, the write-capable-token paragraph,
   the install line and the `npx` caveat, the two per-user directory paths per platform, the
   do-not-parse-stderr paragraph, the `pd fields list` hash recipe, the two-command join recipe, the
   `--search-in` versus `--fields` distinction, the `--limit`-on-search note, the honest
   no-budget-guard paragraph, and the note that parallel `pd` invocations against one credential are
   not free.
2. **Regenerating the prototype samples** under `prototypes/10-output-format/`. They predate `skipped`
   and `duplicates` and therefore no longer match the normative trailer. Under ADR-0002 they are the
   only guard against format drift, so this is a correctness task rather than tidying.
3. **A `CONTEXT.md` pass.** The glossary currently stops at ADR-0011's terms. Terms settled later and
   not yet recorded include *hit*, *push-down*, *sentinel*, *seam*, *anomaly line*, *projection*,
   *fixed-* and *variable-cost resolution* (already present), and *absence*.
4. **Ticket 22 itself stays open.** It should be resolved only when all four items above are done.

### One risk carried into implementation

`pd` will be documented as a read-only tool, and a user may hand it an administrator's token. That
gives a fully privileged credential to a program whose safety rests on its own correctness. The
mitigation is documentation — `pd auth status`, the root `--help` opening, and one `AGENTS.md`
paragraph — and a restricted Pipedrive permission set, which is account administration and outside
`pd`'s reach.
