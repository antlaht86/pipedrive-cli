# Context

Domain vocabulary for `pd`, a read-only Pipedrive CLI whose primary consumer is an AI coding agent.

This file is built lazily, as terms actually get settled. The design effort that produces them is mapped at [`.scratch/pd-cli-design/map.md`](.scratch/pd-cli-design/map.md).

## Glossary

**Variant** — a member of the typed error union. A variant exists only when a caller must respond to it differently from every other variant; a distinct origin is not enough. Settled in [ADR-0001](docs/adr/0001-error-model-and-exit-codes.md).

**`code`** — the field carrying a variant's name in machine-readable output. It is interface, not prose: the spelling never changes, is never translated, and is never reused for a different meaning. Agents branch on `code`. Contrast `message`, which is for humans and free to change.

**Bound** — a limit expressing what the caller *wanted*: `--limit`, `--max-pages`. Reaching a bound is success, and exits 0.

**Guard** — a limit expressing what the caller would *tolerate*: `--max-requests`, the budget guard. Reaching a guard means the work was larger than the allowance, and exits 3. The bound/guard distinction is the reason two superficially similar flags produce different exit codes.

**Completeness marker** — the field on every list output stating whether the result set is complete. Present always, including on full success, so an agent never infers completeness from a record count.

**Daily budget** — the token pool Pipedrive allocates per company account, shared across every user and integration on it. Spending it is a safety concern rather than a performance one, because exhausting it breaks colleagues' integrations. Distinct from the **burst limit**, which counts requests in a rolling 2-second window and is per token.
