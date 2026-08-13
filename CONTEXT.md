# Context

Domain vocabulary for `pd`, a read-only Pipedrive CLI whose primary consumer is an AI coding agent.

This file is built lazily, as terms actually get settled. The design effort that produces them is mapped at [`.scratch/pd-cli-design/map.md`](.scratch/pd-cli-design/map.md).

## Glossary

**Variant** — a member of the typed error union. A variant exists only when a caller must respond to it differently from every other variant; a distinct origin is not enough. Settled in [ADR-0001](docs/adr/0001-error-model-and-exit-codes.md).

**`code`** — the field carrying a variant's name in machine-readable output. It is interface, not prose: the spelling never changes, is never translated, and is never reused for a different meaning. Agents branch on `code`. Contrast `message`, which is for humans and free to change.

**Bound** — a limit expressing what the caller *wanted*: `--limit`, `--max-pages`. Reaching a bound is success, and exits 0.

**Guard** — a limit expressing what the caller would *tolerate*: `--max-requests`. Reaching a guard means the work was larger than the allowance, and exits 3. The bound/guard distinction is the reason two superficially similar flags produce different exit codes. `--max-requests` is the only one: [ADR-0010](docs/adr/0010-budget-guard.md) decided there is no budget guard, and `--resolve-budget` is not one either, because exhausting it degrades and exits 0.

**Completeness marker** — the field on every list output stating whether the result set is complete. Present always, including on full success, so an agent never infers completeness from a record count.

**Daily budget** — the token pool Pipedrive allocates per company account, shared across every user and integration on it. Spending it is a safety concern rather than a performance one, because exhausting it breaks colleagues' integrations. Distinct from the **burst limit**, which counts requests in a rolling 2-second window and is per token.

**Envelope schema** — the schema for the wrapper around a list response: `success`, `data` as an array of unknown, and `additional_data.next_cursor`. Contrast the **record schema**, which describes one element of `data`. They are separate because they fail differently. Settled in [ADR-0006](docs/adr/0006-validation-placement-and-rejection.md).

**Structural failure** — a validation failure of the envelope schema, or a body that is not JSON at all. It ends the walk as `invalid_response`. Contrast a **per-record failure**, which drops one record, emits a `warning` and increments `skipped` while the walk continues.

**Resolution** — turning an id into the name it stands for: a custom field hash into its label, an option id into its option label, an owner id into a person's name. Always opt-in behind the single `--resolve` flag, and always **additive** — the raw value stays so output remains diffable and re-queryable. Settled for owner ids in [ADR-0007](docs/adr/0007-the-narrow-v1-users-client.md), and in full in [ADR-0008](docs/adr/0008-resolution-mechanics.md).

**Fixed-cost resolution** — the part of `--resolve` whose request count does not depend on how much data is walked: the field schemas, `users`, `pipelines` and `stages`. At most nine requests on a cold cache, zero on a warm one. Contrast **variable-cost resolution**, the person and organization lookups that scale with the number of distinct ids in the result set. Only the variable part is charged against `--resolve-budget`, because only the variable part can surprise the shared daily budget.

**Degrade** — the response to a failure in an enrichment rather than in the answer: drop the enrichment for the rest of the run, emit one `warning`, mark the output partial, and exit 0. Reserved for work the caller asked for as a decoration. A failure in the thing the caller actually asked for is an error, not a degradation — the asymmetry is why a `users` fetch failure degrades under `--resolve` but is fatal to `pd users list`.

**Burst gate** — the rolling 2-second rate limiter in the client module, distinct from the `p-limit` concurrency limiter beside it. `p-limit` bounds requests *in flight*; the gate bounds requests *per window*, which is the quantity Pipedrive's burst limit actually counts. Latency converts between the two, so no concurrency value alone protects the window. Settled in [ADR-0011](docs/adr/0011-concurrency-and-retry.md).

**Endpoint family** — the key the burst gate is partitioned by. Two exist: every non-search operation sits in `default` at 10 requests per 2 seconds, and the search paths sit in `search` at 5. A search request spends **both** allowances, which is the conservative reading of an undocumented question. Only `default` is raised by an observed `x-ratelimit-limit`; the Search API's ceiling is uniform across plans and does not move with one.

**Strike** — one burst 429 against the whole gate. Strikes are counted per *run*, not per request, because a 429 pauses every request rather than the one that met it. Three strikes end the run as `rate_limited`. Contrast a **retry**, which is per request and counts 5xx and transport failures against a separate budget: three retries per request at 250 ms / 1 s / 4 s, ten per run, then `upstream`.

**Failure carrier** — the one value `pd` throws on purpose. `guardedFetch` is typed as `typeof fetch`, so its signature has no channel for a `Result`; a refusal or an exhausted budget therefore travels as a thrown `PdFailure` holding an error object, and the wrapper converts it back with `fromPromise`. It is confined to that seam, and every status the seam does not own is handed back as a `Response` untouched. Settled in [ADR-0023](docs/adr/0023-the-guardedfetch-failure-carrier-and-the-retry-attempt-count.md).

**Cause** — the deduplication key of a `warning` line: `(resource, field path, zod issue code)`. One `warning` is emitted per distinct cause, however many records share it. `skipped` still counts every record.

**Tier** — one step of the credential precedence chain: `--token-file`, `PD_API_TOKEN`, then the credentials file. First match wins, and the environment sits above the file so an exported credential never loses silently to a stored one. `pd` reads every tier and writes none. A tier that is *named on the command line* and does not answer stops the run as `usage`; a tier nobody named simply does not answer, and the chain continues. Settled in [ADR-0012](docs/adr/0012-authentication-and-credential-resolution.md) and [ADR-0022](docs/adr/0022-credential-resolution-edge-cases.md).

**Fingerprint** — the first 16 hex characters of the SHA-256 of the resolved API token. One value with two jobs: it names the cache directory ([ADR-0005](docs/adr/0005-cache-design.md) §2) and it is what `pd auth status` prints, so a human can match a running configuration to a cache directory without `pd` printing anything reversible. It is a derived value and not a secret.

**Kind** — the discriminator on a `warning` line, read after `type`. Eight exist, enumerated by name in the spec and registered in `src/lib/warnings.ts`. `kind` is interface in the same sense `code` is; adding one is additive and non-breaking.
