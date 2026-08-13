# 04 — `guardedFetch`: the single HTTP seam

**What to build:** Every HTTP request `pd` will ever make passes through one module that rate-limits it, retries it, counts it, and refuses it outright if it is not a GET. A non-GET driven through the client yields `write_blocked`, exit 1, and dispatches nothing to the network. A retry sequence that would stall six real seconds runs in milliseconds under an injected clock. A test with no recorded fixture fails, because the default transport throws.

No command uses this yet — it is verified by unit tests and by every later ticket inheriting it.

**Blocked by:** 02

**Status:** done

Normative: ADR-0011 (concurrency and retry), ADR-0013 §1, §4–5 (read-only layer b), ADR-0019 §seams (the replay seam and the clock), ADR-0010 §429 inference.

Notes for the implementer:

- **Locked point 7:** rate limiting, retry, concurrency limiting, request accounting, redaction and logging live in this module and **nowhere else**. If any of them appears in a page loop later, this decision has been violated. Both generated clients share one `guardedFetch`; they differ only in `baseUrl`.
- **Base URL** is fixed at `https://api.pipedrive.com`. The per-company form is not used — learning the company domain requires an operation `pd` does not have.
- **Read-only layer (b):** a non-GET refusal inside the custom `fetch`, **before** the network call. It is not redundant with the generation filter: generated functions accept a per-call `fetch` and `baseUrl` spread after `url`, so a wrapper bug can construct a request layer (a) never sees. Layer (b) inspects the request the runtime is about to issue, not the argument it was handed. When it fires: `write_blocked`, exit 1, `retry: never`, `details` carrying method and resolved path, message stating this is a bug in `pd` and not a usage error.
- **Burst gate:** a rolling 2-second window in front of `p-limit`. `p-limit` bounds requests *in flight*; the gate bounds requests *per window*, which is what Pipedrive counts. Default **10 requests per 2 seconds** — half the smallest documented plan window. Raised to half of an observed `x-ratelimit-limit` for the remainder of the process, **never lowered**. An absent header carries no information and changes nothing.
- **Gate families** are keyed internally. Every non-search operation is `default`; the search endpoints are one `search` family at 5 requests per 2 seconds. A search request is assumed to spend **both** allowances.
- **Concurrency is a fixed 4.** No flag, no environment variable, no manifest entry.
- **A 429 pauses the whole gate**, in flight and queued, for the backoff interval — not just the request that met it.
- **Burst retries:** 3 strikes per run, each wait `x-ratelimit-reset` clamped to at most 2 seconds (flat 2 s when absent) — roughly 6 seconds of stall, then `rate_limited`, exit 3.
- **5xx and transport retries:** 3 attempts per request at 250 ms / 1 s / 4 s with full jitter, and 10 retries per run in total, then `upstream`, exit 1. A **separate** counter from burst strikes.
- **A 429 not inferable as burst, and a Cloudflare 403, are never retried.** The inference is `x-ratelimit-remaining` above zero implies the daily pool rather than the burst window; when the inference is unavailable, choose `budget_exhausted` and stop, because the opposite mistake blocks the whole company.
- **A response is never assumed to be JSON.** The Cloudflare block body is HTML, and 403 is overloaded between that block and an ordinary permission failure — separate them by **body shape**, not by status.
- **Seams, and nothing more.** One injected transport (fixture replay installs here), one injected `Clock` (`now()` and `sleep()`, with jitter seeded from the same source so backoff tests assert exact durations). **No test-only flag or environment variable of any kind.**
- The replay layer sits **below** the non-GET refusal, so no test can test its way past the read-only property, and every replay test is another execution of the refusal path.
- Replay is **strict**: no passthrough, a request with no matching fixture is a test failure. The default gate is constructed with a transport that **throws**, so zero requests per `bun test` is mechanical rather than disciplinary. Fixtures are keyed by method, path and the sorted query parameters `pd` actually varies.
- The replay store is **not** the cache — fixtures are committed, never expire, and are not credential-keyed. Keep them separate.

- [x] A non-GET driven through the client yields `write_blocked`, exit 1, and the gate records zero dispatches
- [x] The burst gate holds 10 requests per rolling 2 s by default, and raises (never lowers) on an observed `x-ratelimit-limit`
- [x] Search operations use a separate `search` family at 5 per 2 s and spend both allowances
- [x] Concurrency is fixed at 4 with no way to change it
- [x] A 429 pauses the whole gate; three burst strikes end the run as `rate_limited`, exit 3, in milliseconds under the injected clock
- [x] 5xx and transport retries run 250 ms / 1 s / 4 s with seeded jitter, cap at 10 per run, then `upstream`, exit 1
- [x] An unattributable 429 produces `budget_exhausted` immediately with no retry
- [x] A Cloudflare HTML 403 body is never parsed as JSON and is never retried
- [x] Fixture replay is installed at this seam, is strict, and the default transport throws
- [x] Injected `Clock` covers `now()` and `sleep()`, and jitter is seeded from it

## What the implementation settled, for the tickets that inherit it

Two of these were inventions rather than readings, so they are ratified in
[ADR-0023](../../../docs/adr/0023-the-guardedfetch-failure-carrier-and-the-retry-attempt-count.md)
rather than left here: where a ticket and an ADR disagree, the ADR wins.

- **`guardedFetch` throws one carrier, `PdFailure`, and returns everything else**
  (ADR-0023 §1). Its type is `typeof fetch`, so there is no channel on it for a
  `Result`. The refusals and the exhausted budgets — `write_blocked`,
  `rate_limited`, `budget_exhausted`, `blocked`, `upstream`, and `internal` for
  an absent transport — travel as a thrown `PdFailure` holding an ADR-0001 error
  object; **every other status is handed back as a `Response` untouched**,
  including 401, a JSON 403 and 404. Mapping those to `auth` / `forbidden` /
  `not_found` is ticket 05's, at the wrapper seam, with `fromPromise` unwrapping
  the carrier.
- **ADR-0011 §8's "3 attempts" is three *waits*** — 250 ms, 1 s, 4 s — so a
  request that keeps meeting a 5xx is dispatched at most four times, and the
  ten-retry run cap buys three fully-retried requests plus one (ADR-0023 §2).
- **Concurrent 429s burn strikes together.** Four in-flight requests meeting a
  429 from the same window increment the strike count four times, so the run
  ends as `rate_limited` at once rather than after three paused windows. That is
  a reading rather than a stated rule, and it errs toward stopping, which is the
  direction ADR-0001 asks for. It can only fire during enrichment fan-out — a
  cursor walk is sequential — so tickets 11 and 12 are the ones that meet it.
- **A transport that refuses with a `PdFailure` is never retried** (ADR-0023 §3).
  An absent transport and a missing fixture both report `internal` at the first
  dispatch, instead of being retried three times and disguised as `upstream`.
- **stderr logging is *not* implemented here**, though locked point 7 places it
  in this module. `redactUrl` is, and ADR-0013 §4's "stderr logs the same, at
  error level" is inherited by ticket 17, which owns the format. Ticket 17 must
  add it to this module and to no other.
- **The Clock carries `random()`** beside `now()` and `sleep()`, because
  ADR-0019 §4 requires the full jitter to be seeded from the same injected
  source. Nothing else in `pd` gains a parameter.
- **`--max-requests` is not wired here.** `dispatches()` counts every attempt,
  before the transport is called, and is the counter every *"and no request was
  made"* assertion in the map reads — but it is accounting, not a ceiling.
  Ticket 06 inherits the hook and owes the **reservation** half of ADR-0011 §9:
  a request takes its slot before it is sent, and releases nothing on success.
- **The `blocked` sentinel is not written here.** This module produces the
  `blocked` error; ticket 09 owns the on-disk sentinel and the refusal that
  reads it.
- **Nothing is wired into the generated `client.gen.ts` singletons**, which are
  regenerated output. `PIPEDRIVE_V1_BASE_URL` and `PIPEDRIVE_V2_BASE_URL` are
  exported for ticket 05 to configure the clients from the wrapper.
- **The fake clock and the replay transport live in `test/support/`**, and the
  test file lives beside the module rather than under `test/`, because it drives
  a non-GET through the generated client and ESLint layer (c) confines that
  import to `src/lib/pipedrive/**`.
