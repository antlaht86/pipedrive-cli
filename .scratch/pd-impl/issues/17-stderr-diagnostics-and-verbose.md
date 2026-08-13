# 17 — stderr diagnostics and `--verbose`

**What to build:** A human watching a twenty-second walk at a terminal sees a rewriting status line and can tell it apart from a hang. When something paced the run — a gate pause, a 5xx backoff, the self-raising ceiling, a cache skip — a permanent line says so. `--verbose` adds one line per request with query values redacted by allowlist. An agent piping the same command to a file sees exactly two things on stderr and loses no fact by ignoring the channel entirely.

**Blocked by:** 06

**Status:** ready-for-agent

Normative: ADR-0015 (stderr and run diagnostics).

## The invariant that makes the channel safe

**In machine mode, nothing on stderr is the sole carrier of any fact.** Agent harnesses treat the channel inconsistently, so that invariant is what makes it safe to use at all.

Notes for the implementer:

- **Default stderr is exactly two things:** the one-line error summary, and the per-10,000-record warning on an unbounded run. A successful bounded run is **byte-silent**.
- Progress is **TTY-gated on stderr's own descriptor**. Environment-dependent behaviour is legitimate here precisely because stderr is declared not a contract.
- **stderr is prose and is not a contract.** No JSON, no `type` tag, no stable wording, no `--log-format`. If telemetry is ever wanted, the answer is "there is none".
- One `\r`-rewriting status line at about **1 Hz** carrying records, requests and elapsed time, plus **permanent appended anomaly lines** for gate pauses, 5xx backoffs, the self-raising ceiling, cache skips and the 10,000-record warning. A final summary replaces the status line and **reports no token cost**.
- `--verbose` forces everything on **regardless of TTY** and adds a per-request line: method, path, redacted query, status, duration, attempt number, cache hit. **No `-v`, no `--quiet`, no level scale, no environment variable.** It never changes a byte of stdout.
- **Redaction is allowlist-based in both directions.** Query values print only for: `limit`, `cursor`, `sort_by`, `sort_direction`, `include_option_labels`, `ids`, `custom_fields`, `exact_match`, `item_types`, `fields`, `status`, `person_id`, `organization_id`, `owner_id`, `org_id`, `deal_id`, `pipeline_id`, `stage_id`, `done`, `filter_id`, `updated_since`, `updated_until`. Everything else prints its name with `[redacted]`.
- **`term` is refused permanently** — a search term is company data.
- Headers print from an allowlist — `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`, `content-type` — and **`x-api-token` cannot be added**.
- **Response bodies are never logged at any verbosity.** Debugging must not write the CRM to a file whose permissions `pd` does not control.
- Path segments including ids print whole.
- One injected TTY predicate on the diagnostics module is the seam. **No test-only flag or environment variable.**

- [ ] A non-TTY run emits exactly two things on stderr, and neither is progress (replay test)
- [ ] A successful bounded non-TTY run is byte-silent on stderr
- [ ] A TTY run shows a `\r`-rewriting status line at roughly 1 Hz with records, requests and elapsed
- [ ] Gate pauses, 5xx backoffs, the self-raising ceiling, cache skips and the 10,000-record warning each append a permanent line
- [ ] The final summary replaces the status line and reports no token cost
- [ ] `--verbose` forces diagnostics on regardless of TTY and adds one line per request
- [ ] `--verbose` changes no byte of stdout, asserted by byte comparison
- [ ] Query values outside the allowlist print as `[redacted]`, and `term` is redacted unconditionally
- [ ] Headers outside the allowlist never print, and `x-api-token` cannot be allowlisted
- [ ] No response body reaches stderr at any verbosity
- [ ] A CI gate asserts no unredacted query value and no non-allowlisted header can reach stderr
- [ ] No `-v`, `--quiet`, `--log-format` or logging environment variable exists
