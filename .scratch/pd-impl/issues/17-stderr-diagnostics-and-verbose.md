# 17 — stderr diagnostics and `--verbose`

**What to build:** A human watching a twenty-second walk at a terminal sees a rewriting status line and can tell it apart from a hang. When something paced the run — a gate pause, a 5xx backoff, the self-raising ceiling, a cache skip — a permanent line says so. `--verbose` adds one line per request with query values redacted by allowlist. An agent piping the same command to a file sees exactly two things on stderr and loses no fact by ignoring the channel entirely.

**Blocked by:** 06

**Status:** done

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

- [x] A non-TTY run emits exactly two things on stderr, and neither is progress (replay test)
- [x] A successful bounded non-TTY run is byte-silent on stderr
- [x] A TTY run shows a `\r`-rewriting status line at roughly 1 Hz with records, requests and elapsed
- [x] Gate pauses, 5xx backoffs, the self-raising ceiling, cache skips and the 10,000-record warning each append a permanent line
- [x] The final summary replaces the status line and reports no token cost
- [x] `--verbose` forces diagnostics on regardless of TTY and adds one line per request
- [x] `--verbose` changes no byte of stdout, asserted by byte comparison
- [x] Query values outside the allowlist print as `[redacted]`, and `term` is redacted unconditionally
- [x] Headers outside the allowlist never print, and `x-api-token` cannot be allowlisted
- [x] No response body reaches stderr at any verbosity
- [x] A CI gate asserts no unredacted query value and no non-allowlisted header can reach stderr
- [x] No `-v`, `--quiet`, `--log-format` or logging environment variable exists

## Comments

**2026-08-17 — verification.** The work landed in `b7f9431` and `965c9a9`.

| Box | Evidence |
| --- | --- |
| Non-TTY stderr is exactly two things, neither progress | `test/deals-list.test.ts`, "a default non-TTY replay is silent on success…" — the failure case is one line starting `pd: ` and containing no `\r`, and the 10,000-record case is the only stderr line of a large run |
| A bounded non-TTY run is byte-silent | same test, and `src/lib/output/diagnostics.test.ts`, "a bounded successful machine run is byte-silent" |
| TTY status line at roughly 1 Hz | "a TTY timer rewrites progress at roughly 1 Hz", asserting the `\r` prefix, records, requests and elapsed |
| Five anomaly sources each append a permanent line | the self-raising ceiling, the 5xx backoff and the gate pause are the three `diagnostics.anomaly` call sites in `guarded-fetch.ts`; the cache skip routes through `NdjsonWriter.warn`, and the 10,000-record warning through `sizeWarning`. The TTY test asserts a permanent line survives beside the rewriting one |
| Final summary replaces the status line, no token cost | same TTY test: the `finished:` line, and `not.toContain("token")` |
| `--verbose` forces diagnostics on without a TTY | `test/deals-list.test.ts`, "--verbose changes no stdout byte and forces request diagnostics without a TTY" |
| `--verbose` changes no byte of stdout | same test, a direct byte comparison of the two runs |
| Non-allowlisted query values redacted, `term` unconditionally | "verbose request lines redact query values and headers by allowlist", plus the new source assertion below |
| Non-allowlisted headers never print, `x-api-token` cannot be allowlisted | same pair |
| No response body at any verbosity | the same test feeds a response body and asserts it is absent from stderr |
| A CI gate asserts the redaction property | see the note below |
| No `-v`, `--quiet`, `--log-format`, no logging environment variable | "does not add aliases or logging controls beside --verbose" |

Two structural guards were unasserted and now are. ADR-0015 §6 refuses `term` and `x-api-token`
**unconditionally**, by an explicit check on top of each allowlist — and neither guard can be reached
by a crafted request, because neither name is in an allowlist for the guard to override. The existing
test therefore passed with both guards deleted. They are now pinned against the source, the way
`test/generated-read-only.test.ts` pins the read-only property: the point of a defence like that is to
survive the edit that makes it live.

One box needed reading rather than looking up. **"A CI gate asserts no unredacted query value and no
non-allowlisted header can reach stderr"** — there is no such check in `scripts/release-gates.ts`.
What enforces it is `src/lib/output/diagnostics.test.ts` under `bun test`, which CI runs as a plain
`run` step, so a violation fails the build rather than warning. That satisfies the property ADR-0015
§6 and ticket 20's gate table demand, and the box is ticked on that basis — but it is a test, not a
gate script, and this paragraph is here so nobody goes looking for the script.

The environment-variable half of the last box could not be a refusal: a variable `pd` honoured would
simply work. The test now sets the names a harness sets by habit — `PD_VERBOSE`, `PD_LOG_LEVEL`,
`PD_LOG_FORMAT`, `DEBUG`, `VERBOSE` — and compares both channels against a run without them.
