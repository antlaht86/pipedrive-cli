# 06 — `--limit` and `--max-requests`

**What to build:** An agent runs `pd deals list --limit 100` and gets exactly 100 records and exit 0 — a deliberately bounded query does not look like a failure. The same agent runs `pd deals list --max-requests 4`, hits the ceiling, and gets exit 3 with a truncated answer it can never mistake for a complete one. The two flags are deliberately different things.

**Blocked by:** 05

**Status:** ready-for-agent

Normative: ADR-0003 (pagination bounding and partiality), ADR-0001 (exit codes), ADR-0010 (the budget position).

## The bound/guard distinction

A **bound** expresses what the caller *wanted*: `--limit`. Reaching it is success, exit 0, and the trailer is a `summary` carrying `reason: "limit"`.

A **guard** expresses what the caller would *tolerate*: `--max-requests`. Reaching it means the work was larger than the allowance.

**Spec ruling, not negotiable:** a guard stop is an **`error`** trailer with `code: "request_ceiling"`, exit 3, `retry: "never"`. ADR-0008 §10 and ADR-0018 §3 write `reason: "max_requests"` — they are wrong. ADR-0001 and ADR-0003 own the output contract and win. **There is no `reason: "max_requests"`**, and `reason` today has exactly one value, `"limit"`, and appears only on a bounded `summary`.

Notes for the implementer:

- `--limit <n>` is a **record count**, never a page size. Positive integer, no upper bound.
- **`--limit` is counted after rejection and deduplication**, so asking for 100 never yields 97 with no explanation.
- **The bound must not lie.** A limit that fills exactly at a page boundary with a `null` cursor reports `complete: true`. A limit that fills where the cursor continues reports `complete: false`, **even if the next page would have been empty**. The conservative error is deliberate.
- `--limit` does not exist on non-list commands; passing it there is a usage error, not a silent no-op.
- **The default is everything.** An unbounded run writes a stderr warning on crossing 10,000 emitted records and every subsequent 10,000. Not configurable.
- `--max-requests` counts **network requests** and has **no default**. It is the only quantitative guard `pd` offers.
- Headroom is reserved **before** dispatch, and retries count against it.
- A cache hit does not count against `--max-requests` (relevant from ticket 08 onward).
- **`pd` does not guard the shared daily budget and says so.** No floor, no daily token ceiling, no cross-invocation ledger. Every input a guard would need is unreadable.

- [ ] `--limit 100` emits exactly 100 records and exits 0 with `reason: "limit"` on a `summary` trailer
- [ ] `--limit` counts after rejection and deduplication
- [ ] A limit filling at a page boundary with a `null` cursor reports `complete: true`
- [ ] A limit filling where the cursor continues reports `complete: false`
- [ ] `--max-requests` produces an `error` trailer with `code: "request_ceiling"`, exit 3, and no `reason` field
- [ ] Headroom is reserved before dispatch and retries count against it
- [ ] An unbounded run emits a stderr warning at every 10,000 emitted records
- [ ] `--limit` on a non-list command is a usage error, exit 2
- [ ] Both flags reject non-positive and non-integer values offline with exit 2
