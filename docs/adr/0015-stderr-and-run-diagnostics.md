# ADR-0015: What stderr carries, and how a long run reports progress

Status: accepted
Date: 2026-08-12
Deciding ticket: [What stderr carries, and how a long run reports progress](../../.scratch/pd-cli-design/issues/24-grilling-stderr-diagnostics.md)
Extends: [ADR-0009](0009-command-surface-and-manifest.md) — adds an eighth global flag, `--verbose`
Closes: [ADR-0011](0011-concurrency-and-retry.md) §"The effective gate and concurrency belong in stderr diagnostics" — this ADR owns the shape
Confirms: [ADR-0001](0001-error-model-and-exit-codes.md), [ADR-0002](0002-output-format.md) — stdout stays the only machine channel; no new error variant, no exit-code change
Amended by: [ADR-0016](0016-field-projection.md) §10 — §6's query-value allowlist gains `custom_fields`
Amended by: [ADR-0017](0017-search-and-list-filtering.md) §10 — §6's allowlist gains the search and filter parameters; the search `term` is permanently refused

## Context

stdout is fully spoken for. ADR-0002 made it NDJSON records plus exactly one trailer, with three
prose exceptions already carved out (`--help`, `pd manifest`, `pd docs`). Locked note 4 forbids
banners, progress and colour there outright. Everything this ticket could specify therefore lives on
stderr or nowhere.

But stderr arrives pre-loaded with a self-contradiction that had to be resolved before anything
could be added to it. ADR-0001 moved the machine-readable error object **off** stderr and onto
stdout, with an explicit reason: "agent harnesses do not treat stderr consistently — some swallow
it, some truncate it, some forward it only on failure". If stderr is unreliable enough to disqualify
it for the single most important message `pd` can emit, the burden of proof sits on anything else
proposed for it.

Three prior ADRs had already put content there anyway, and this ADR inherits rather than revisits
them:

- **ADR-0001** — a human-readable one-line summary of every error, **unconditional**.
- **ADR-0003** — a warning on crossing 10,000 emitted records on an unbounded run, and every
  subsequent 10,000. ADR-0010 §8 leans on it as the only signal that a walk is large.
- **ADR-0002 / ADR-0005 §5** — under `--pretty` the `warning` line has no NDJSON stream to live in,
  so it is rendered to stderr instead.

Two facts sharpened the progress question after the ticket was written. ADR-0002 measured
time-to-first-byte at ~250 ms streaming and ~20 s under `--pretty`, which buffers the whole set to
compute column widths. And ADR-0011 introduced **silent stalls**: a burst 429 pauses the whole gate
for up to ~6 s per run, a 5xx backs off up to ~5 s per request, and the rolling-window gate raises
its own ceiling mid-run from an observed `x-ratelimit-limit`. A quiet `pd` no longer means only
"this is a long walk".

One premise in the ticket body is false and was corrected before it could shape the answer. There is
no `api_token` query parameter in either OpenAPI spec — ADR-0012 §10 established the token travels
in the `x-api-token` header alone. A logged URL does not leak the credential. It leaks search terms
and filter values, which are company data, so the redaction rule survives on a different footing.

## Decision

### 1. Default stderr is exactly two things, and neither is progress

With no flags and no TTY, a run writes to stderr:

1. ADR-0001's one-line error summary, if the run fails.
2. ADR-0003's large-walk warning, on every 10,000 emitted records of an unbounded run.

Nothing else. A successful, bounded run is byte-silent on stderr. This is the agent-first posture:
the consumer that cannot be trusted to receive the channel is not sent anything it would need.

The two survivors are not exceptions to that reasoning, they are the reason it is safe. Neither is
load-bearing. If the harness swallows the error line, the caller still has the full error object on
stdout with its `code`, per ADR-0001. If it swallows the 10,000-record warning, the caller still has
`emitted` on the trailer. **In machine mode, nothing on stderr is the sole carrier of any fact.**
That is the invariant this ADR adds, and every later section is checked against it.

The qualifier is load-bearing. Under `--pretty` there *is* no NDJSON stream, so ADR-0002 and
ADR-0005 §5 route the `warning` line to stderr as its only carrier, and ADR-0002 §"no machine-readable
error object" does the same for the error. The invariant is not violated there, it is inapplicable:
`--pretty` is documented as never invoked by an agent, so its reader is a human sitting at the
terminal that stderr is going to.

### 2. Progress exists, and it is gated on stderr being a TTY

When stderr is a TTY, `pd` writes progress and diagnostics to it. When it is not, it does not.

This makes observable behaviour depend on the environment, which is exactly what locked note 4
forbids on stdout — so it is worth stating why the same conditionality is accepted here. stdout is a
**contract**; a contract that changes shape under redirection is unusable. stderr is, by §3, not a
contract at all. TTY-conditioning a non-contract costs nothing a caller can depend on, and it is the
only mechanism that gives a human feedback without giving an agent noise, at the price of zero
flags.

The detection is on **stderr's** own file descriptor, never stdout's. `pd deals list > out.ndjson`
in a terminal is the common human case and it keeps its progress; `pd deals list 2>log.txt` gets a
clean log with no control characters in it.

`--verbose` (§5) forces everything on regardless of TTY. There is no flag to force it off: a human
who wants silence redirects stderr, and an agent is already silent.

### 3. stderr is prose, and is not a contract

Every line stderr carries is free-form human text. There is no JSON on stderr, no `type` tag, no
stable wording, no `--log-format` flag, and no manifest description of the channel's content.
`AGENTS.md` states it directly: **do not parse stderr; its content and wording change without a
version bump.**

The rejected alternative was structured stderr — NDJSON with the same discipline as stdout, so a
supervising tool could collect telemetry. It was refused because a machine-readable channel is a
promise whether or not the documentation says so. The moment one consumer parses it, `pd` has two
output contracts, and one of them disappears into a harness's stderr handling at random. ADR-0002
made stdout the only machine channel deliberately; a parseable stderr quietly undoes that.

A `--log-format json` compromise was rejected for a smaller reason: it costs a flag, a second
formatter and a permanent test surface for a consumer that does not exist. The consequence is
accepted plainly — if telemetry is ever wanted, the answer is "there is none", not "pass a flag".

### 4. One rewriting status line, plus permanent lines for anomalies

Under §2's TTY condition, two distinct kinds of output share the channel and are rendered
differently.

**The status line** is a single line rewritten in place with `\r`, refreshed about once a second. It
carries the counters the caller can already see on the trailer — records emitted, network requests
made, elapsed time — and under `--pretty` it reports the buffering phase instead, because there are
no records to report until the table is computed. It is a liveness indicator: a human's question
during a 20-second walk is "is it moving", not "how far".

**Anomaly lines** are ordinary appended lines, printed above the status line and never overwritten.
They are the events a human would want to still be on screen after the run:

- a 429 pausing the gate, with the pause duration and the strike count (ADR-0011 §7)
- a 5xx retry with its backoff (ADR-0011 §8)
- the gate raising its own ceiling from an observed `x-ratelimit-limit` (ADR-0011 §5)
- a cache entry skipped as broken (ADR-0005 §5), a refresh on an unrecognised credential hash
- ADR-0003's 10,000-record warning, which is already unconditional per §1 and simply appears here too

**The final summary** replaces the status line when the run ends: records emitted, network requests
made, elapsed time. Under `--max-requests` it also reports the ceiling. It reports no token cost and
no share of the daily pool — ADR-0010 established that every input needed for that number is
unreadable, and printing an estimate would hand a human a figure to plan against that `pd` cannot
stand behind.

A line-per-page alternative was rejected: 80 lines for 80 requests is 80 lines nobody reads, and
under `--pretty` it is 80 lines printed *before* the first row of the table. An anomalies-only
alternative was rejected for failing the original problem — a normal 20-second walk and a hung one
would both be silent, which is the exact ambiguity ADR-0011's stalls created.

### 5. `--verbose` is the eighth global flag, and the only one this ADR adds

`--verbose` is a boolean global flag. It forces §4's progress and anomaly output on regardless of
TTY, and adds a line per HTTP request: method, path, redacted query, status, duration, attempt
number, and whether the response came from an **upstream** cache — Pipedrive's or Cloudflare's, read
from the response's `age`, `x-cache` and `cf-cache-status` headers. The field is named
`upstream_cache_hit` for that reason (ticket 25).

It can never report ADR-0005's own cache. A hit there short-circuits before a request is formed, so
there is no request line to carry it. `--verbose` emits a line of its own instead, naming the entry
and saying that nothing was dispatched:

```
pd: users served from cache, no request
pd: GET /api/v2/deals status=200 duration=180ms attempt=1 upstream_cache_hit=no
```

That line is behind `--verbose` alone, not a plain TTY run, because it is the counterpart of the
request line above it. A cache hit is not a request and never moves the trailer's `requests` count —
the whole point of the report is that the number went down.

No short form — ADR-0009 §"no synonyms" forbids `-v`. No `--quiet`, because the default is already
silent for every consumer that would want it. No level scale (`--log-level=debug`): with prose that
is not a contract, a second verbosity tier is a distinction only `pd`'s own authors could use.

**No environment variable.** `PD_LOG` was rejected: a variable that changes what a run prints makes
two invocations with identical argv behave differently, and the argv is what a human sees in a
harness transcript when they ask why the output looks wrong. Credentials are the only thing `pd`
reads from the environment (ADR-0012 §3), and they are there because they must not appear in argv —
a diagnostic setting has the opposite requirement.

`--verbose` appears in the manifest's global flag table, because it is a flag and the flag surface
is a contract. Its *effects* are not described there beyond "writes diagnostics to stderr", because
§3 refuses to make stderr's content contractual. **`--verbose` never changes a byte of stdout** —
not the records, not the trailer, not the error object.

### 6. Request logging redacts by allowlist, in both directions

`--verbose` prints URLs, and a Pipedrive URL carries company data. The rule:

- **Query parameters**: values are printed only for an allowlist of structural parameters —
  `limit`, `cursor`, `sort_by`, `sort_direction`, `include_option_labels`, `ids`. Every other
  parameter prints its name with its value replaced by `[redacted]`. This covers `term` on the
  search family (ticket 26), filter values, and anything a future flag adds — a new parameter is
  redacted by default rather than leaked by default.
- **Path segments** are printed whole, ids included. A record id is the one piece of company data
  that is useless to debug without, and it is already in the caller's own command line.
- **Headers** are printed from an allowlist, never a denylist — ADR-0012 §10's constraint, inherited
  verbatim. Today: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`,
  `retry-after`, `content-type`. `x-api-token` is not on it and cannot be added.
- **Response bodies are never logged**, at any verbosity. A logged body is the whole CRM record in a
  file whose permissions `pd` does not control.

### 7. `--pretty` is where progress earns its place, and it says so

`--pretty` buffers everything before printing anything (ADR-0002), so a human sees a blank terminal
for the full duration — ~20 s on the 40,000-record case, against ~250 ms streaming. That is the
strongest case for progress in the whole design, and it is the case where §2's TTY gate is most
reliably satisfied, since `--pretty` is documented as never invoked by an agent.

The status line under `--pretty` reports records **collected**, not emitted, and names the buffering
explicitly, so the human is not left wondering why a counter is climbing while the screen stays
empty.

### 8. `pd auth status` remains outside all of this

ADR-0012 §5 makes `pd auth status` a stdout command emitting one JSON object at zero requests, and
ADR-0013 §6 hung `credential_is_write_capable` and `warnings` on it. It answers "which credential,
from where, and what it can do" without stderr's help, and none of it moves here. Two channels for
one question would guarantee they disagree.

## Assumptions recorded rather than asked

Implementation-level, decided rather than put to the user, per the map's altitude rule.

- **The status line is redrawn on a timer, not per record.** A 40,000-record walk redrawing per
  record would spend more time on terminal I/O than on HTTP. ~1 Hz is below the rate at which a
  human reads a changing number and above the rate at which the display looks frozen.
- **A page of records redraws once, on top of the timer.** Ticket 23 measured the gap the timer alone
  leaves: an anomaly line redraws the status line from the response headers, which is before the
  page's records are counted, so a completed request can sit next to `0 records` — the one reading a
  human watches that line to rule out. Arriving records therefore schedule a redraw of their own,
  coalesced so a whole page costs one write rather than one per record, and a run that reaches its
  trailer in the same tick as its records draws that redraw before the final summary replaces it.
- **The status line gives the terminal line back before stdout writes to it.** The line carries no
  newline, which is what makes it rewritable, so the cursor is parked on it. §2's gate is satisfied
  by a bare `pd deals list` with no redirection, where stdout is the same terminal: a `record` line
  would land on the status text and scroll it into scrollback, where no later `\r` can reach it.
  Ticket 24 therefore erases the line before every NDJSON write, from the writer that owns stdout,
  at the same one-per-page cost as the redraw above — the second and every later record of a page
  find nothing to erase. This does **not** make the status line conditional on stdout: the erase is
  unconditional and §2's "never stdout's descriptor" is untouched. The section's
  `pd deals list > out.ndjson` is now the case the erase is wasted on rather than the case the
  status line depends on. The `--pretty` table is the one stdout write that goes round that funnel,
  and it needs no erase: §7 already suppresses the status line while the table prints, so the
  diagnostics trailer has cleared the line and ended on a newline before the first row lands.
- **A cache hit is reported where it is served, not where the entry is read.** Ticket 25 measured a
  `deals list --resolve` run twice: seven requests cold, three warm, and the `--verbose` log said
  nothing about the four that disappeared. Three read sites answer a hit with a request anyway — a
  warm entry whose every record has stopped validating, a warm `get` whose id is not in it, and a
  resolution entry that no longer parses — so the line is written at the point the run commits to
  the cached records, not at the `read` that returned them. A hit that is followed by a refetch
  reports the refetch and not "no request". The cache-only owner resolver never dispatches and so
  could report either way; it defers on the same rule, because "served from cache" about an entry
  that did not answer contradicts the `owner_resolution_unavailable` warning underneath it.
- **`\r` is used only under §2's TTY condition**, which is already the gate for the whole status
  line, so no control character can reach a redirected stderr. No cursor addressing, no ANSI colour,
  no alternate screen — a `\r` and a trailing space-pad to erase the previous line's tail is the
  entire mechanism.
- **Diagnostics are written through one stderr writer**, the mirror of ADR-0004's `NdjsonWriter`
  owning stdout. It holds the TTY decision, the counters and the status-line state, so no other
  module decides whether to print.
- **Elapsed time is wall clock from process start**, including credential resolution and cache
  reads, because that is the duration the human is actually waiting through.
- **The status line is suppressed while `--pretty` prints its table**, so the final table is not
  interleaved with a rewriting line on a merged terminal.

## Consequences

- The map's stderr question closes without a new `code`, without an exit-code change and without
  touching stdout in any mode. ADR-0001 and ADR-0002 are confirmed, not amended.
- **ADR-0011's handoff is answered in full**: the effective gate, the concurrency value and every
  gate pause surface as §4 anomaly lines, plus the per-request line under `--verbose`. Concurrency
  and the gate still have no flag and no manifest entry, exactly as ADR-0011 decided — this gives a
  human a way to *see* them without giving anyone a way to *set* them.
- `AGENTS.md` gains one paragraph: stderr is prose, do not parse it, and pass `--limit` rather than
  watching for ADR-0003's warning you may never receive.
- The global flag table grows to seven. ADR-0009 §"the table is a flat list with no per-command
  overrides" holds — `--verbose` is an append and reshapes nothing.
- Ticket 26 (search surface) inherits §6's allowlist as a constraint: whatever parameter it adds for
  a search term is redacted by default and must not be added to the allowlist.
- Ticket 28 (testing strategy) inherits two testable claims: that a non-TTY run emits exactly §1's
  two things, and that no unredacted value reaches stderr under `--verbose`. The second is a safety
  assertion, not a formatting test, and belongs with ADR-0013's CI gates rather than in a snapshot.
- The channel a human relies on and the channel a machine relies on are now disjoint. That is the
  point, and the cost is that a human debugging an agent's failed `pd` run sees whatever the
  harness kept of stdout, and nothing `pd` printed for humans — because in that run, `pd` printed
  nothing for humans.
