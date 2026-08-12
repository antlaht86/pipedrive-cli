# What stderr carries, and how a long run reports progress

Type: grilling
Status: resolved

Blocked by: 10

## Question

stdout is now fully spoken for — NDJSON records and one trailer under
[ADR-0002](../../../docs/adr/0002-output-format.md), a human table under `--pretty`. So what exactly
goes on stderr, and who reads it?

- ADR-0001 fixed one line of it: a human-readable one-liner per error, unconditionally. Is that the
  *only* guaranteed stderr output, or does more ship by default?
- Are the other diagnostics prose for a human, or structured records an agent could parse? ADR-0001's
  reasoning cuts against structured stderr — harnesses swallow, truncate or drop the channel, which
  is exactly why the error object moved to stdout. If stderr is unreliable enough to disqualify it
  for errors, what is it reliable enough for?
- A 40,000-record walk takes ~20 s across 80 requests and now emits its first record after 250 ms.
  Does anything report progress during that, and to whom? stdout is closed to it: banners and
  progress are forbidden there by locked point 4, and a progress line in an NDJSON stream would have
  to be a `type` the consumer must skip.
- Under `--pretty` the human sees no records until the whole set is buffered for column widths. Is
  that the case where progress on stderr actually earns its place?
- Is there a verbosity control — `-v`, `--log-level`, `PD_LOG` — and what is the default? Note that
  request-level logging must respect ADR-0001's redaction rule: an API token may travel as a query
  parameter, so a logged URL leaks the credential.
- Does the budget accounting from the rate-limit research surface anywhere for a human watching a
  run, given no header reports the remaining daily pool?

Record as an ADR if the answer is more than "stderr carries the error line and nothing else".

## Context added while resolving other tickets

- [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md) hands this ticket one concrete candidate
  for stderr. Concurrency and the burst gate have **no flag and no manifest entry**, and the gate raises
  itself mid-run from an observed `x-ratelimit-limit` (§5), so a human debugging a slow command has no
  other way to see what paced it. Whether the effective gate, the concurrency value and gate pauses
  surface on stderr is this ticket's call.
- Related: a burst 429 now costs up to ~6 s of whole-gate pause (§7) and a 5xx up to ~5 s of backoff
  (§8). Both are silent stalls in the middle of a run, and they enlarge the progress question already in
  the body — a walk can now be quiet for reasons other than being long.
- **The redaction premise in the body above is false, and the rule survives anyway.**
  [ADR-0012](../../../docs/adr/0012-authentication-and-credential-resolution.md) §10 found no
  `api_token` query parameter exists in either OpenAPI spec — the token travels in the `x-api-token`
  header alone. A logged URL therefore does not leak the credential; it leaks user-supplied search
  terms and filter values, which are company data. Same rule, different reason, and this ticket should
  word the verbosity control accordingly. ADR-0012 §10 also fixes that headers are printed from an
  **allowlist**, never a denylist — a constraint on whatever debug dump this ticket specifies.
- **`pd auth status` is not a diagnostic channel.** ADR-0012 §5 makes it a stdout command emitting one
  JSON object at zero requests. It answers "which credential, from where" without stderr's help.

## Answer

Recorded as [ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md).

**Default stderr is exactly two things, and neither is progress**: ADR-0001's one-line error summary and ADR-0003's per-10,000-record large-walk warning. A successful bounded run with no TTY is byte-silent. The invariant that makes this safe is that **in machine mode nothing on stderr is the sole carrier of any fact** — the error line duplicates stdout's error object, the walk warning duplicates the trailer's `emitted`. That answers the ticket's sharpest question: stderr is reliable enough only for things that do not matter if lost.

**Progress exists and is gated on stderr being a TTY** — not stdout's. Observable behaviour therefore varies by environment, which locked note 4 forbids on stdout; accepted here because stdout is a contract and stderr, by decision, is not. Zero flags, and the agent gets no noise it would not read.

**stderr is prose, and explicitly not a contract.** No JSON, no `type` tags, no `--log-format`, no manifest description of the channel's content. Structured stderr was rejected because a machine-readable channel becomes a promise the moment anyone parses it, giving `pd` two output contracts when ADR-0002 deliberately built one. Consequence accepted: if telemetry is ever wanted, the answer is "there is none", not "pass a flag".

**One `\r`-rewriting status line at ~1 Hz, plus permanent appended lines for anomalies**, and a final summary that replaces the status line. Anomalies are ADR-0011's 429 gate pauses, 5xx backoffs and the self-raising gate ceiling, plus ADR-0005's cache skips. Line-per-page was rejected (80 unread lines, and under `--pretty` all 80 print before the first row); anomalies-only was rejected because a normal 20 s walk and a hung one would both be silent — the exact ambiguity ADR-0011 created.

**`--verbose` is the eighth global flag and the only addition to the surface.** No `-v` (ADR-0009 bans short forms), no `--quiet` (the default is already silent for anyone who would want it), no level scale, and no `PD_LOG` — an environment variable would make two runs with identical argv print differently, and argv is what a human reads in a harness transcript. `--verbose` never changes a byte of stdout.

**Redaction is by allowlist in both directions.** The ticket's premise was already corrected: the token is header-borne, so a URL leaks company data rather than the credential — same rule, different reason. Query values print only for `limit`, `cursor`, `sort_by`, `sort_direction`, `include_option_labels`, `ids`; every other parameter is `[redacted]`, so a future flag leaks nothing by default. Headers from ADR-0012 §10's allowlist. Response bodies never logged at any verbosity.

**`--pretty` is where progress earns its place** — ~20 s of blank terminal against ~250 ms streaming — and its status line counts records *collected*, naming the buffering so a climbing counter over an empty screen is not a mystery.

**No new error variant, no exit-code change, no `pd auth status` involvement.** ADR-0001 and ADR-0002 are confirmed rather than amended, and ADR-0011's explicit handoff is closed: the gate and concurrency become visible without becoming settable.
