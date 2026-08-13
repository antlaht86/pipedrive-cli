# 06 — `--limit` and `--max-requests`

**What to build:** An agent runs `pd deals list --limit 100` and gets exactly 100 records and exit 0 — a deliberately bounded query does not look like a failure. The same agent runs `pd deals list --max-requests 4`, hits the ceiling, and gets exit 3 with a truncated answer it can never mistake for a complete one. The two flags are deliberately different things.

**Blocked by:** 05

**Status:** done

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

- [x] `--limit 100` emits exactly 100 records and exits 0 with `reason: "limit"` on a `summary` trailer
- [x] `--limit` counts after rejection and deduplication
- [x] A limit filling at a page boundary with a `null` cursor reports `complete: true`
- [x] A limit filling where the cursor continues reports `complete: false`
- [x] `--max-requests` produces an `error` trailer with `code: "request_ceiling"`, exit 3, and no `reason` field
- [x] Headroom is reserved before dispatch and retries count against it
- [x] An unbounded run emits a stderr warning at every 10,000 emitted records
- [x] `--limit` on a non-list command is a usage error, exit 2
- [x] Both flags reject non-positive and non-integer values offline with exit 2

## What shipped, and what it changed

Most of the bound was already standing: ticket 05 built the countdown and the
marker-may-not-lie rule into `walk`, and `walk.test.ts` already asserted the
four cases. This ticket wired the flags to it, built the guard, and answered
three questions the ADRs left open. All three are ratified as
[ADR-0026](../../../docs/adr/0026-the-guards-scope-and-the-size-warnings-one-suppressor.md):

1. **`--max-requests` exists on `get` as well as on `list`.** ADR-0003 scopes
   only the bound to list commands; the guard is defined over a run, and a `get`
   is a run that dispatches and retries. So the option table is per-verb, and
   the unrecognised-flag refusal names the flags *that* verb takes rather than
   one fixed list.
2. **`--limit` suppresses the 10,000-record stderr warning; `--max-requests`
   does not.** A bound states the output the caller wants, a guard states the
   spend it tolerates, and only the first makes the warning redundant.
3. **Headroom is reserved synchronously ahead of the gate's first `await`**, and
   the reservation counter *is* the trailer's `requests`. That is what makes
   concurrent requests unable to overspend the ceiling and a retried 5xx spend
   it — and it makes `requests` on a `request_ceiling` trailer equal the ceiling
   exactly, never exceed it.

Two smaller things, recorded rather than decided: `request_ceiling`'s `details`
now names the `path` that met the ceiling, and the flag values are validated by
an exact `/^[1-9][0-9]*$/` rather than `z.coerce`, because `Number(" 4")` is 4
and `Number("1e3")` is 1000 and neither is a spelling the caller wrote.

The normative sample `f-usage-error.ndjson` was regenerated, because the
unknown-flag message it captures now lists three flags.

Left for the tickets that own them: the cache's "a cache hit does not count
against `--max-requests`" (08), and ADR-0010 §4's rule that an enrichment
request yields to the remaining headroom (11–12) — there is no enrichment to
yield yet, so `guardedFetch` exposes no headroom reader.

Also left, and named here because it is the half of a ticket bullet this one
does not deliver: **"`pd` does not guard the shared daily budget and says so"**.
The "does not guard" half is true of the code — no floor, no ledger, no daily
ceiling, and nothing added here moves toward one. The "says so" half has nowhere
to live until ticket 19 writes `AGENTS.md`, which is also where ADR-0003 puts
the "pass `--limit` unless you know the set is small" guidance and the
documentation of the 10,000-record warning.
