# ADR-0023: How a refusal leaves `guardedFetch`, and how many attempts "3 attempts" is

Status: accepted
Date: 2026-08-13
Deciding input: implementation ticket [04](../../.scratch/pd-impl/issues/04-guardedfetch-the-single-http-seam.md), plus the two questions its review surfaced as inventions rather than readings
Amends: [ADR-0011](0011-concurrency-and-retry.md) §8 — "3 attempts per request" is fixed as three *retries* after the first dispatch
Extends: [ADR-0019](0019-testing-strategy.md) §3 — a transport that refuses is not a transport that failed, and the two must not share a budget

## Context

Ticket 04 built `guardedFetch`, the single HTTP seam. Two of its decisions were made in code, and
both were flagged in review as inventions rather than readings of an existing ADR — which is the
signal that they belong here. The spec's own rule is that where a ticket and an ADR disagree the ADR
wins, so a decision recorded only in a ticket is one the next implementer may reverse.

Neither is large. Both are recorded because a later module will copy the first without its
justification, and because the second silently changes the arithmetic of a documented budget.

## Decision

### 1. `guardedFetch` throws one carrier, and that is the sanctioned exception to the no-throw rule

`CLAUDE.md` requires application code to return `Result` / `ResultAsync` and to reserve `throw` for
third-party boundaries wrapped with `fromThrowable` / `fromPromise`. `guardedFetch` breaks that, and
the reason is structural rather than stylistic.

The generated SDK accepts a per-call and per-client `fetch` typed as `typeof fetch`
(research 06 §1.5). Its return type is `Promise<Response>`. There is therefore **no channel on the
seam for a `Result`**: the only ways to report a refusal are a `Response` that lies about being one,
or a throw.

So `guardedFetch` throws exactly one value, `PdFailure`, holding an [ADR-0001](0001-error-model-and-exit-codes.md)
error object and nothing else. The wrapper module converts it back to a `Result` with `fromPromise`.
That is the same boundary rule `CLAUDE.md` states, applied to a throw `pd` raised rather than to one
a library did — and it is confined to this seam.

Three properties keep it confined:

- **The carrier does not extend `Error`.** There is no stack worth keeping and no message worth
  reading past `error.message`, and an accidental `catch (e) { e.message }` fails loudly rather than
  quietly producing prose that bypasses the typed union.
- **What travels as a throw is a closed set**: `write_blocked`, `rate_limited`, `budget_exhausted`,
  `blocked`, `upstream`, and `internal` for a transport that is absent. **Every other status is
  handed back as a `Response`, untouched** — 401, a JSON 403 and 404 included. Mapping those to
  `auth` / `forbidden` / `not_found` is the wrapper's, on the `Result` side of the boundary.
- **No other module may adopt this.** A module that is not constrained to somebody else's function
  signature has a channel for a `Result` and must use it.

### 2. "3 attempts per request" means the first dispatch plus three retries

[ADR-0011](0011-concurrency-and-retry.md) §8 says "**Per request: 3 attempts**, with waits of 250 ms,
1 s and 4 s". Those two halves cannot both be true: three waits do not fit inside three attempts.
The ambiguity is settled in favour of the **waits**, because they are the concrete numbers, they are
repeated in ticket 04's acceptance list, and they are what a test can assert.

So a request that keeps meeting a 5xx or a transport failure is dispatched **at most four times**:
one initial dispatch, then retries after 250 ms, 1 s and 4 s, each with full jitter. Then `upstream`,
exit 1.

This moves an arithmetic that §8 states elsewhere and is worth restating: the run-level cap of **10
retries** now buys three fully-retried requests plus one retry, not three and a third. The cap's
purpose — stopping an 80-page walk from turning per-page retries into hundreds of requests against a
service that is plainly down — is unaffected.

The burst strikes of §7 are untouched and remain a **separate** counter: three strikes per run, each
a whole-gate pause, never drawn from the ten.

### 3. A transport that refuses is reported, not retried

[ADR-0019](0019-testing-strategy.md) §3 makes the default transport one that throws, so a missing
fixture fails the test that needed it. That property is worth only as much as the report it produces.

A rejection carrying a `PdFailure` is therefore **never retried**: it has already said what went
wrong and that waiting cannot fix it. Only an unrecognised rejection is treated as a transport
failure and put on §2's budget.

Without this rule an absent transport or a missing fixture is retried three times and reported as
`upstream` with the real reason buried in `details` — and it silently consumes three of the run's ten
retries, corrupting the accounting a surrounding test may itself be asserting. The absent transport
and the missing fixture both report `internal`, which is what a programmer error is called.

## Consequences

- **`CLAUDE.md`'s no-throw rule now has one written exception with a named boundary.** A reviewer
  meeting `throw new PdFailure(...)` outside `src/lib/pipedrive/guarded-fetch.ts` should treat it as
  a defect rather than as precedent.
- **[ADR-0011](0011-concurrency-and-retry.md) §8's per-request budget is four dispatches**, and the
  run cap of ten retries is unchanged. No other number in §8 moves.
- **Nothing in the agent-visible contract changed.** No new `code`, no new flag, no new exit code.
  `internal` and `upstream` already existed, and the carrier never reaches stdout — the wrapper
  unwraps it into the same error object [ADR-0001](0001-error-model-and-exit-codes.md) already
  specifies.
- **The stderr half of locked point 7 is still owed.** Ticket 04 implemented the redaction
  (`redactUrl`) but emits nothing; [ADR-0013](0013-read-only-enforcement.md) §4's "stderr logs the
  same, at error level" is inherited by the stderr-diagnostics ticket, which owns the format.
