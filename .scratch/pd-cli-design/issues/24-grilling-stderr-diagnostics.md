# What stderr carries, and how a long run reports progress

Type: grilling
Status: open

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
