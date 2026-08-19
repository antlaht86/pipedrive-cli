# 25 — `--verbose` reports the wrong cache, and says nothing when the right one works

**What to build:** a `--verbose` log in which a human can see that `pd`'s own cache worked.

**Blocked by:** None — can start immediately.

**Status:** done

Normative: [ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) §5 (the per-request line
and what it carries), §1 (a machine run is byte-silent). Touches [ADR-0005](../../../docs/adr/0005-cache-and-invalidation.md)'s
four cached resources only as the thing being reported on.

## Observed

Measured on the live account, 2026-08-19, recorded in ticket 12's `## Comments`. The same command
run twice, cold cache then warm:

| Run | Requests | What was dispatched |
| --- | --- | --- |
| Cold | 7 | `dealFields`, `users`, `pipelines`, `stages`, `deals`, `persons`, `organizations` |
| Warm | 3 | `deals`, `persons`, `organizations` |

Four requests disappeared between the two runs, and **the `--verbose` log says nothing about it**.
The three that remain each report `cache_hit=no`.

Both halves of that are misleading, for one underlying reason: `cache_hit` does not mean `pd`'s
cache. It is read from the response's `age`, `x-cache` and `cf-cache-status` headers, so it reports
an **upstream** cache — Pipedrive's or Cloudflare's. `pd`'s own cache short-circuits before the
request is ever formed, so a hit produces no line at all, and `cache_hit=yes` can never describe it.

## Why it is worth fixing

A human runs `--verbose` to answer "is the cache working". The log answers `cache_hit=no` on every
line, which reads as *no*. The truth is the opposite: the cache worked so well that four requests
were never dispatched. ADR-0015 §5 promises the line says "whether the response came from cache"
without naming which cache, so the wording is not wrong so much as unanswerable.

This is the same failure mode as tickets 23 and 24 — a human-facing diagnostic that a human reads
backwards — and the same reasoning applies: stderr is not a contract, but it is the only thing a
human has.

## What to change

Both halves, because either alone leaves the question unanswerable:

- A cache hit on one of ADR-0005's four cached resources emits its own line naming the entry and
  saying no request was dispatched.
- The per-request field is renamed so it names the upstream cache it actually reads.

```
pd: users served from cache, no request
pd: GET /api/v2/deals status=200 duration=180ms attempt=1 upstream_cache_hit=no
```

Three decisions taken rather than left open:

- **The cache line is `--verbose` only**, not a plain TTY run. It is the counterpart of the
  per-request line, and §5 puts that behind `--verbose`; a bare TTY run keeps its status line and
  its anomalies and gains nothing here.
- **A cache hit is not a request and does not move the counter.** The trailer's `requests` is
  unchanged by this ticket, and the whole point of the measurement above is that the number went
  down.
- **No new flag.** §5 already refuses a second verbosity tier.

## Acceptance

- [x] Under `--verbose`, a hit on each of the four cached resources emits a line naming the entry
      and stating that no request was dispatched
- [x] The per-request field names the upstream cache rather than "cache"
- [x] A cold run and a warm run of the same command are distinguishable from the `--verbose` log
      alone, without comparing request counts
- [x] The trailer's `requests` count is unchanged, and a cache hit never increments it
- [x] A machine run — no TTY, no `--verbose` — stays byte-silent on stderr
- [x] stdout is byte-identical in every mode
- [x] ADR-0015 §5 is amended to name which cache the per-request field reports
- [x] No new flag, no change to the status line or the trailer grammar

## Comments

Both halves moved. `RunDiagnostics.cacheServed(entry)` writes the new line, and the per-request
field is `upstream_cache_hit`. The carried property was renamed with it — `cacheHit` became
`upstreamCacheHit`, at the producer in `guarded-fetch.ts` as well — because a comment explaining
that `cacheHit` means somebody else's cache is the rename it was standing in for.

`cacheServed` is gated on `--verbose` rather than on `#enabled`, so a bare TTY run is unchanged, and
it takes a `CacheEntryName` rather than a `string`, so the closed eight-entry list stays a compile
error rather than a discipline. `NdjsonWriter.cacheServed` forwards it, which is what lets the read
sites report without each holding a diagnostics handle.

The line is written where the run **commits** to the cached records, not at the `store.read` that
returned them. Three sites answer a hit with a request anyway and would otherwise print "no request"
immediately before dispatching one:

- `commands/cached.ts` list — a warm entry whose every record has stopped validating is refetched.
- `commands/cached.ts` get — a warm entry that does not carry the asked-for id is refetched.
- `output/resolution.ts` `load` — a hit whose records will not parse falls through to `fresh`.

The cache-only owner resolver in `output/resolution.ts` never fetches, so it could report either
way. It defers on the same rule: "served from cache" about an entry that did not answer would
contradict the `owner_resolution_unavailable` warning printed underneath it. `/code-review` raised
that site, and the placement above is the fix.

Verified by `test/verbose-cache.test.ts`, which runs `deals list --resolve` twice against one
temporary cache home: cold, five requests and no cache line; warm, one request and a line for each
of `dealFields`, `users`, `pipelines` and `stages`. stdout is identical between `--verbose` and
plain at the same cache temperature, and stderr is byte-silent with neither flag nor TTY.
`diagnostics.test.ts` holds the `--verbose`-only gate against a TTY-only run and the refusal after
the trailer.

ADR-0015 §5 now names the upstream cache and shows both lines; its implementation-notes list gained
the placement decision. CONTEXT.md gained an **Upstream cache** entry, because the term became
load-bearing vocabulary this ticket had no glossary word for.
