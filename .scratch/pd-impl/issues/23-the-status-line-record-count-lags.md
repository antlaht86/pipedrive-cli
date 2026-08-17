# 23 — The TTY status line reports a record count it has not caught up with

**What to build:** a status line whose record count matches what the run has emitted.

**Status:** needs-triage

Normative: [ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) (the temporary TTY status
line, overwritten in place, distinct from the permanent anomaly line).

## Observed

One run of `pd deals list --limit 1 --fields custom_fields` against a real account, on the same
invocation that produced ticket 22's measurement:

```
pd: rate-limit gate raised from 10 to 20 requests per window
pd: 0 records, 1 requests, 0.3s, gate 20/5 per 2s, concurrency 4
...
pd: finished: 1 records, 1 requests, 0.3s
```

The mid-run line says `0 records` while `requests: 1` — the page had already arrived. The trailer and
the `finished:` line both say `1`, so the counter itself is right and only the status line's timing is
wrong: it renders after the request completes but before the page's records are counted.

## Why it is filed rather than fixed

The status line is temporary, human-facing and explicitly not a machine contract, so this is cosmetic.
It is still worth a ticket: `0 records` next to a completed request reads as *the walk returned
nothing*, which is the one thing a human watches that line to find out.

## Acceptance

- [ ] A single-page run never renders a status line claiming `0 records` after that page's records
      have been emitted.
- [ ] The trailer, the `finished:` line and the last status line agree on the count.
- [ ] No new flag, no change to the trailer, no change to the anomaly-line grammar.
