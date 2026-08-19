# 12 — `--resolve`, variable-cost half

**What to build:** Under `--resolve`, person and organization relations gain their names too — batched per page, never buffering the walk. The implicit requests this costs cannot surprise the shared budget: they stop at fifty by default, they yield to `--max-requests` rather than tripping it, and exhausting the budget degrades the run to raw ids at exit 0.

**Blocked by:** 11

**Status:** done

Normative: ADR-0008 §variable cost, ADR-0010 (the budget position), ADR-0003 (bounding).

Notes for the implementer:

- **Relation ids are batched per page**, 100 per request, with a run-scoped id→name map. **Buffering the whole walk would silently convert a streaming read into a collected one** — that is the reason for per-page batching, not performance.
- Ceiling **50 requests by default**, settable with `--resolve-budget <n>`.
- **`--resolve-budget` is not a guard.** Exhausting it degrades and exits 0 — one `resolution_budget_exhausted` warning, raw ids for the rest of the run, `resolved: "partial"`. Contrast `--max-requests`, which exits 3.
- **Enrichment yields to `--max-requests` and never trips it.** A batch is dispatched only if the remaining headroom survives it; otherwise resolution stops as if the resolve budget were spent. This is what keeps `request_ceiling` reflecting only the caller's own query.
- Projection runs **before** the resolve prefetch, so `--fields` shrinks resolve consumption as a side effect.
- Search commands accept `--resolve` and resolve **owner ids only, at zero requests** (see ticket 14 — a hit already carries `stage_name`, `person_name` and `org_name` from the API).
- **Search gets no ceiling of its own.** Its requests are the ones the caller asked for; `--resolve-budget` exists because resolve's requests are implicit. The asymmetry is deliberate.

- [x] Person and organization relations resolve to `person_name` / `org_name` under `--resolve`
- [x] Batching is per page at 100 ids per request, with a run-scoped id→name map
- [x] The walk stays streaming — records still start arriving in roughly 250 ms under `--resolve`
- [x] The default ceiling is 50 requests and `--resolve-budget <n>` changes it
- [x] Exhausting the resolve budget emits one `resolution_budget_exhausted` warning, sets `resolved: "partial"`, and exits **0**
- [x] A batch is dispatched only if `--max-requests` headroom survives it, so enrichment never produces `request_ceiling`
- [x] `--fields` measurably reduces resolve request count on the same fixture
- [x] `--resolve` on a search command resolves owner ids only and dispatches zero extra requests — deferred to ticket 14, which introduces search commands, and delivered there

## What shipped

Variable-cost resolution now scans each projected page for standard and custom person/organization relations, fetches unseen ids in batches of 100, and keeps run-scoped name maps. Each page is enriched and emitted before the next walk page is requested.

Relation batches have a soft 50-request default ceiling, configurable with `--resolve-budget`. Spending that ceiling—or lacking surviving `--max-requests` headroom—warns once, marks resolution partial, leaves subsequent ids raw, and preserves exit 0. Search-specific zero-cost owner resolution remains with ticket 14 because this branch has no search command surface yet.

## Comments

**2026-08-19 — the deferred box is closed by ticket 14.** Search-side owner resolution shipped with
the search verb, as this ticket said it would. `test/search.test.ts` covers both halves: a cold owner
cache dispatches nothing and reports `resolved: "partial"`, and a warm one reads the names out of
cache with no extra request.

**2026-08-19 — measured against the live account.** Three runs of `pd deals list --limit 500
--resolve --verbose`, cold cache first, captured through a pseudoterminal. All three emitted 500
records with `skipped: 0` and `resolved: "full"`.

| Run | Requests | What was dispatched |
| --- | --- | --- |
| Cold cache | 7 | `dealFields`, `users`, `pipelines`, `stages`, `deals`, `persons`, `organizations` |
| Warm cache | 3 | `deals`, `persons`, `organizations` |
| `--fields id,title` | 1 | `deals` |

Three things this settles, none previously measured against a real account:

- **The cache saves four requests per run** — the whole fixed-cost tier, ADR-0005's four cached
  resources, in one hit. 1.2s falls to 0.5s.
- **Variable-cost resolution stays run-scoped.** `persons` and `organizations` are dispatched again
  on the warm run, which is what ticket 12 designed: the id→name map lives for the run and is not
  persisted. One batch each covered every relation on the page, well inside the 100-id batch size
  and nowhere near the 50-request budget, so no `resolution_budget_exhausted` warning was raised.
- **The `--fields` box is confirmed on real data.** `id,title` excludes `person_id` and `org_id`,
  and the resolve requests fall to zero — one request for the whole run.

Two caveats recorded rather than claimed. The trailer says `resolved: "full"` on the `--fields` run,
where nothing was resolved because nothing needed resolving; ADR-0008's tri-state cannot separate
"resolved everything" from "there was nothing to resolve", and that is the contract rather than a
fault. And a 500-record run is one page, so it cannot show enrichment interleaving with the next
page's fetch — every request necessarily precedes the first record here, and the streaming claim
needs a multi-page run to test.
