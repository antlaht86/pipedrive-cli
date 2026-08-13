# ADR-0001: Error model, exit codes and machine-readable failure

Status: accepted
Date: 2026-08-11
Deciding ticket: [The error union, exit codes, and machine-readable failure](../../.scratch/pd-cli-design/issues/09-grilling-error-union-and-exit-codes.md)

## Context

`pd` is a read-only Pipedrive CLI whose primary consumer is an AI coding agent on no particular harness. Errors are values, carried by a typed union rather than by `Error`, so exit codes and machine-readable output fall out of the types. An agent must be able to act on a failure without parsing prose.

Two findings from research constrain this decision and are cited where they bite:

- No response header reports the remaining daily token budget, and a 429 caused by daily exhaustion is indistinguishable from one caused by the 2-second burst window by anything documented. Continuing to retry a 429 earns a Cloudflare 403 whose body is HTML and which blocks the whole company's `api_token` traffic. See [rate limiting research](../../.scratch/pd-cli-design/research/01-rate-limits-and-token-budget.md).
- ~~An API token may be transmitted as a query parameter, so a request URL is credential-bearing.~~ **Corrected by [ADR-0012](0012-authentication-and-credential-resolution.md) §10**: no `api_token` query parameter exists in either OpenAPI spec; the documented transport is the `x-api-token` header alone. The URL-redaction rule below survives on a different ground — a request URL carries user-supplied search terms and filter values, which are company data with no business on an agent's stdout by default. See [auth research](../../.scratch/pd-cli-design/research/05-auth-mechanisms.md).

## Decision

### The error payload goes to stdout

A failure emits a machine-readable error object on **stdout**, in the same format family as successful output. stderr carries a human-readable one-line summary of the same error. Usage errors use the identical form and channel — a caller should not have to learn two error shapes.

Two reasons. When pagination streams and a later page fails, bytes are already on stdout; writing the error there keeps one stream in causal order and reuses the trailer structure that partial results need. And agent harnesses do not treat stderr consistently — some swallow it, some truncate it, some forward it only on failure — while stdout is the one channel every harness passes through. Where agent and human ergonomics conflict, the agent wins.

The cost, accepted: `pd deals list > deals.json` writes a file containing an error rather than data. The exit code already said so, and the alternative would write a *truncated* array to the same file, which is worse because it looks valid.

### Eleven variants, each earning its place by a distinct caller response

*Amended: the union is **twelve**. [ADR-0013](0013-read-only-enforcement.md) §4 adds `write_blocked`
(exit 1, `retry: never`) — a write reached the guard and no request left the process.
[ADR-0014](0014-distribution.md) §9 added a thirteenth, `unsupported_runtime`, which
[ADR-0021](0021-distribution-build-from-source.md) §7 **withdraws**: the compiled binary carries its
own runtime, so there is no host runtime to be wrong.*

A variant exists only if the caller must respond differently to it — not because it has a distinct origin. Two HTTP statuses leading to the same action are one variant.

| Variant | When | Caller's response |
| --- | --- | --- |
| `usage` | Bad argument, unknown command | Fix the command |
| `auth` | Credential missing, invalid or revoked | A human must supply one |
| `forbidden` | Credential valid, permission insufficient | A human must grant access |
| `not_found` | The named resource does not exist | Ask something else |
| `rate_limited` | Burst window exhausted, retries spent | Wait, retry |
| `budget_exhausted` | Shared daily token pool gone | Stop for today |
| `request_ceiling` | `--max-requests` reached | Raise the ceiling and run again (see [ADR-0003](0003-pagination-bounding-and-partiality.md): there is no resumption) |
| `blocked` | Cloudflare block on the company's traffic | Stop immediately, tell a human |
| `upstream` | 5xx or transport failure after retries | Retry later |
| `invalid_response` | Pipedrive returned data the schema rejects | Retrying will not help |
| `internal` | A programmer error that escaped | File a bug |

`auth` covers **no credential found anywhere in the precedence chain**, not only a credential the API rejected. [ADR-0012](0012-authentication-and-credential-resolution.md) §7 settled that against research 08's suggestion of exit 2: no argument the caller can supply produces a credential, so exit 2's "invoked wrongly, try different arguments" would send an agent into a futile retry.

Cache corruption is deliberately **not** a variant. `pd` evicts a corrupt entry and refetches, so it never surfaces. A tool able to advise "try `--no-cache`" is able to do it itself.

`not_found` applies to fetching a single named resource. A list with no matches is an empty success, not an error.

### Exit codes, and what discriminates within one

| Exit | Variants |
| --- | --- |
| `0` | Success |
| `2` | `usage` |
| `3` | `rate_limited`, `budget_exhausted`, `request_ceiling`, `blocked` |
| `1` | `auth`, `forbidden`, `not_found`, `upstream`, `invalid_response`, `internal` |

Exit 1 is a grab bag of six, so the exit code is only ever a coarse signal for shell-level control flow. All fine-grained decisions read the `code` field, whose value **is the variant name**. `code` is interface: its spelling never changes, is never translated, and is never reworded. `message` is for humans and may change freely. An agent branches on `code`, never on `message`.

The error object carries its own exit code — redundant for a shell, but a harness that captured only stdout has no other way to know it. The full mapping table ships in the machine-readable command manifest, not only in prose documentation, so a harness discovers the `code` values and their handling rather than hardcoding or guessing them.

### An ambiguous 429 is treated as `budget_exhausted`

Both variants are kept, because the caller's correct response genuinely differs. `pd` attempts to tell them apart — a 429 carrying `x-ratelimit-remaining` above zero implies the daily budget rather than the burst window, since the burst counter is not spent. This is inference from the headers, not a documented fact.

When the inference is unavailable, `pd` chooses `budget_exhausted` and stops. The costs are asymmetric: mistaking burst for budget wastes one run, while mistaking budget for burst produces a retry loop that escalates to a Cloudflare block on the entire company's API traffic. In doubt, stop.

`blocked` exists as its own variant for that Cloudflare 403 because its blast radius is the whole account rather than this run. It also forces a rule into the client module: **a response must never be assumed to be JSON.** The 403 body is HTML, and parsing it as JSON would disguise a company-wide block as `invalid_response`. Note that 403 is overloaded — a Cloudflare block and an ordinary permission failure share the status and are separated by body shape, not by status code.

### Bounds exit 0; guards exit 3

A **bound** expresses what the caller wanted: `--limit 100` returning a hundred records did exactly what was asked. A **guard** expresses what the caller would tolerate: `--max-requests 50` filling up means the work was larger than the budget allowed for it.

| Cause of stopping | Exit | `code` |
| --- | --- | --- |
| `--limit` / `--max-pages` reached | `0` | — |
| Everything fetched | `0` | — |
| `--max-requests` reached | `3` | `request_ceiling` |
| Daily budget exhausted | `3` | `budget_exhausted` |
| Burst exhausted, retries spent | `3` | `rate_limited` |
| Cloudflare block | `3` | `blocked` |
| Failure mid-stream | `1` | the matching variant |

If a bound returned non-zero, every deliberately bounded query would look like a failure and agents would learn to ignore the exit code, breaking the mechanism entirely. If a guard returned zero, an agent could report 3,200 deals out of 40,000 as a complete answer.

**Every list output carries a completeness marker at all times**, including on success — not only when something went wrong. An agent reading stdout alone must never have to infer completeness from a record count. The marker's contents are decided in the pagination-bounding ticket; this ADR fixes only that the field always exists and that the exit code is not the sole signal.

### `retry` answers one question, and makes new variants non-breaking

Retryability is derivable from `code`, and derived data in a payload drifts. It is carried explicitly anyway, for forward compatibility: an agent meeting a `code` added after its harness was written can still act.

The field answers exactly one question — *will repeating the identical command succeed, and when?*

| Value | Meaning | Variants |
| --- | --- | --- |
| `never` | Waiting cannot help; something must change | `usage`, `auth`, `forbidden`, `not_found`, `invalid_response`, `internal`, `request_ceiling` |
| `after` | Yes, after `retry_after_seconds` | `rate_limited`, `upstream` |
| `not_today` | Yes, but not before the daily reset | `budget_exhausted`, `blocked` |

`request_ceiling` is `never` despite appearances: repeating the identical command hits the identical ceiling. The agent learns to raise it from `code`, which keeps `retry` unambiguous.

`not_today` is a distinct value rather than a large second count because the daily budget resets "at midnight at server's timezone" and **the server timezone is named nowhere**. A fabricated countdown would be a lie.

`retry` advises the caller about a fresh invocation, never about retrying inside `pd`. By the time `rate_limited` reaches a caller, the client module has already retried and given up.

### What `pd` retries internally

All requests are GET, so a retry is always safe for correctness. The only risk is load.

| Situation | Retried |
| --- | --- |
| Transport failure, dropped connection | Yes, exponential backoff, capped |
| 5xx | Yes, exponential backoff, capped |
| 429 inferred as burst | Yes, but a low cap |
| 429 inferred as budget, or not inferable | **Never.** Stop immediately |
| 403 Cloudflare block | **Never.** Stop immediately |
| Other 4xx | No |

The burst window is two seconds, so waiting and continuing is the documented behaviour and normal pagination would break without it. The cap stays low because this is precisely the loop that escalates into a Cloudflare block if left running.

Concrete counts, delays and caps are derived from the burst allowance in the concurrency ticket. This ADR fixes the shape of the policy: what is touched and what is not.

### The error object

```json
{
  "code": "rate_limited",
  "message": "Burst limit exceeded and retries were exhausted.",
  "exit_code": 3,
  "retry": "after",
  "retry_after_seconds": 4,
  "emitted": 3200,
  "details": {}
}
```

`code`, `message`, `exit_code` and `retry` are present on **every** error, in every variant, so a parser never branches to read the basics. `retry_after_seconds` appears only when `retry` is `after`. `emitted` reports how many records reached stdout before the failure, so a caller knows what it is holding; it is zero when nothing was written.

`details` is **explicitly unstable** — HTTP status, Pipedrive's own error text, the path. Two rules govern it:

- **Nothing in `details` may be branched on.** If something turns out to be actionable it is promoted to a named field. This keeps the stable surface small and deliberate rather than letting it grow with every debug addition.
- **URLs are redacted before they enter `details`.** A request URL — the most natural debug field imaginable — carries the query string, and the query string carries user-supplied search terms and filter values. That is company data, and it would land on stdout, in an agent's context, and from there in logs. Redaction is enforced by the client module, not left to whoever writes the field. (The original justification — that the token travels as a query parameter — was false; see [ADR-0012](0012-authentication-and-credential-resolution.md) §10.)

How an error object is distinguished from a data record while streaming depends on the output format and is decided in that ticket. This ADR fixes only that it is distinguishable, and its field set.

### The stability contract

**Frozen; changing these is a breaking change:** the always-present fields `code`, `message`, `exit_code`, `retry`; the meaning of each exit code; the meaning of an existing `code` value. A `code` is never renamed and never reused for a different meaning.

**Free to change:** the wording of `message`; the entire contents of `details`; **adding new `code` values**; adding new optional fields.

Adding a variant being non-breaking is the point, and it is only possible because `retry` is always present: an agent meeting an unknown `code` still knows whether to wait, give up, or change something. Without that field every new variant would break every harness.

**The error object carries no version number.** The version lives in the command manifest and in `pd --version`. A per-payload version invites branching on version, which is exactly the coupling forward compatibility exists to avoid; and since an unknown `code` is already safe to handle, a consumer never needs it. A log read after the fact should record the command and its version once, not on every line.
