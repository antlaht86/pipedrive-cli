# 12 — `--resolve`, variable-cost half

**What to build:** Under `--resolve`, person and organization relations gain their names too — batched per page, never buffering the walk. The implicit requests this costs cannot surprise the shared budget: they stop at fifty by default, they yield to `--max-requests` rather than tripping it, and exhausting the budget degrades the run to raw ids at exit 0.

**Blocked by:** 11

**Status:** ready-for-agent

Normative: ADR-0008 §variable cost, ADR-0010 (the budget position), ADR-0003 (bounding).

Notes for the implementer:

- **Relation ids are batched per page**, 100 per request, with a run-scoped id→name map. **Buffering the whole walk would silently convert a streaming read into a collected one** — that is the reason for per-page batching, not performance.
- Ceiling **50 requests by default**, settable with `--resolve-budget <n>`.
- **`--resolve-budget` is not a guard.** Exhausting it degrades and exits 0 — one `resolution_budget_exhausted` warning, raw ids for the rest of the run, `resolved: "partial"`. Contrast `--max-requests`, which exits 3.
- **Enrichment yields to `--max-requests` and never trips it.** A batch is dispatched only if the remaining headroom survives it; otherwise resolution stops as if the resolve budget were spent. This is what keeps `request_ceiling` reflecting only the caller's own query.
- Projection runs **before** the resolve prefetch, so `--fields` shrinks resolve consumption as a side effect.
- Search commands accept `--resolve` and resolve **owner ids only, at zero requests** (see ticket 14 — a hit already carries `stage_name`, `person_name` and `org_name` from the API).
- **Search gets no ceiling of its own.** Its requests are the ones the caller asked for; `--resolve-budget` exists because resolve's requests are implicit. The asymmetry is deliberate.

- [ ] Person and organization relations resolve to `person_name` / `org_name` under `--resolve`
- [ ] Batching is per page at 100 ids per request, with a run-scoped id→name map
- [ ] The walk stays streaming — records still start arriving in roughly 250 ms under `--resolve`
- [ ] The default ceiling is 50 requests and `--resolve-budget <n>` changes it
- [ ] Exhausting the resolve budget emits one `resolution_budget_exhausted` warning, sets `resolved: "partial"`, and exits **0**
- [ ] A batch is dispatched only if `--max-requests` headroom survives it, so enrichment never produces `request_ceiling`
- [ ] `--fields` measurably reduces resolve request count on the same fixture
- [ ] `--resolve` on a search command resolves owner ids only and dispatches zero extra requests
