# 23 — The TTY status line reports a record count it has not caught up with

**What to build:** a status line whose record count matches what the run has emitted.

**Status:** done

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

- [x] A single-page run never renders a status line claiming `0 records` after that page's records
      have been emitted.
- [x] The trailer, the `finished:` line and the last status line agree on the count.
- [x] No new flag, no change to the trailer, no change to the anomaly-line grammar.

## Comments

`RunDiagnostics.record` now schedules a redraw of the status line. The redraw is coalesced into a
microtask, so a page of 500 records costs one write and not 500 — ADR-0015's "on a timer, not per
record" cost holds, and the ADR's assumption list records the addition. `refresh` settles the debt
whoever asked for it, so a timer tick landing between the records and the microtask leaves the
microtask nothing to do.

The microtask alone was not enough. `stream` writes the trailer in the **same tick** as the last
page's records on a bounded run (`src/lib/output/stream.ts`), so a `--limit 1` walk finishes before
any microtask runs — exactly the run this ticket measured. `#finishLine` therefore draws a pending
redraw before it clears the line.

That last draw is erased one statement later by the clear, so on a TTY a human never reads it: what
it buys is a **captured** stderr — the `--verbose` log or the transcript this ticket was written
from, where `\r` does not erase and the last status text would otherwise still say `0 records`. It is
the acceptance line "the trailer, the `finished:` line and the last status line agree" taken at the
only level a captured channel has. The visible win is the other one: a multi-page walk now corrects
the count as each page lands instead of waiting for the next timer tick.

Nothing else moved: no flag, no trailer change, no anomaly-line wording change, and a machine run is
still byte-silent because the schedule sits behind the same `#enabled` gate as every other write.

Three tests in `src/lib/output/diagnostics.test.ts`: the anomaly-then-record sequence, run once with
a tick to yield to and once without, the one-redraw-per-page cost, and the byte-silent machine run.

Two findings from `/code-review` were fixed before the commit rather than filed:

1. **The closure notes were under a `## What was built` heading.** `docs/agents/issue-tracker.md`
   puts closure narrative under `## Comments`, which every other closed ticket obeys.
2. **`#redrawPending` was cleared by the microtask rather than by the draw.** A timer tick between
   the records and the microtask redrew the identical line twice, and `#finishLine` consumed the
   flag without clearing it. `refresh` now clears it, so exactly one draw answers one debt.

One review finding is **recorded rather than fixed**, because it is a different defect: the status
line carries no newline, so an NDJSON `record` line written to a shared terminal appends to it and
strands the text in scrollback, where no later `\r` can reach it. That is the likely reason the
observed run showed `0 records` at all, and it is unchanged by this ticket — stdout and stderr
sharing a terminal garbles the status line whatever it says. Worth its own ticket if it is worth
fixing; ADR-0015 §2 already assumes the human case is `pd deals list > out.ndjson`, where it cannot
arise.

589 tests pass, `tsc --noEmit` and `eslint .` clean.
