# 24 — The TTY status line strands itself in scrollback when stdout shares the terminal

**What to build:** a status line that yields the terminal line before anything is written to stdout.

**Status:** done

Normative: [ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) §2 (the TTY gate is on
stderr's own descriptor), §4 (one status line rewritten in place with `\r`, anomaly lines appended
above it).

## Observed

Recorded in ticket 23's `## Comments` as a separate defect and deferred there rather than fixed.

The status line is written with a leading `\r` and **no trailing newline**, which is what makes it
rewritable in place. When stdout and stderr point at the same terminal — a bare `pd deals list` with
no redirection — an NDJSON `record` line lands on the cursor's current line, which is the line the
status text is sitting on. The record's own `\n` then scrolls both away together:

```
pd: 0 records, 1 requests, 0.3s, gate 20/5 per 2s, concurrency 4{"type":"record","record_type":"deal",...}
```

The status text is now in scrollback. The next `\r` reaches the *current* line, so it can neither
overwrite nor erase that text, and the stale count stays on screen for the rest of the run — one
stranded copy per page. It is the likely reason ticket 23's transcript showed `0 records` at all.

## Why it was deferred and why it is now filed

ADR-0015 §2 names `pd deals list > out.ndjson` as the common human case, and the defect cannot arise
there. But that is a statement about which case is common, not a precondition: `pd deals list` with
no redirection is a legal invocation, it satisfies §2's TTY gate exactly, and it is what a human
types first.

## Acceptance

- [x] A `record` line written while a status line is on screen is not appended to that status line
- [x] No stale status text survives in scrollback on a shared terminal
- [x] The clear costs one write per page, not one per record
- [x] stdout is byte-identical in every mode, `--pretty` included
- [x] A machine run — no TTY, no `--verbose` — stays byte-silent on stderr
- [x] Ticket 23's agreement between the trailer, the `finished:` line and the last status line holds
- [x] No new flag, no stdout-descriptor check, no change to the anomaly-line grammar

## Out of scope

Two edges are recorded rather than fixed, because neither is introduced by this ticket:

- A status line **wider than the terminal** wraps, and §4's space-pad erase already cannot reach the
  wrapped tail. Unchanged here.
- `--verbose 2>log.txt` already receives `\r` through the existing status-line path, against
  ADR-0015's "`\r` is used only under §2's TTY condition". The clear sequence adds no new control
  character to a channel that was not already getting them.

## Comments

`RunDiagnostics.yieldLine` erases the status line, and `NdjsonWriter.#line` calls it before every
NDJSON write. `#line` is the single funnel for the whole line grammar — `record`, `warning` and both
trailers — which is the same reason ADR-0004 put stdout behind one writer in the first place.

It is not every byte of stdout, and `/code-review` was right to say so on both axes. Two writes go
round it, and both were checked rather than assumed:

- **The `--pretty` table.** `finish` and `error` render it straight to the sink. Neither strands
  anything, but the reason is **ordering** rather than the funnel: both call the diagnostics writer
  first, and it ends by clearing the status line and appending a newline-terminated `pd: finished:`
  line, so the cursor is already on a fresh line when the table lands. A test asserts exactly that —
  the byte-identity of the table, and that the stderr write immediately before it ends in a newline.
- **`cli.ts`'s top-level rejection handler.** It writes an `error` line to stdout with no
  diagnostics handle to yield with, so a throw that escapes mid-walk strands the status line. It is
  a crash path — `pd ended without writing a trailer` — and reaching it means the run already failed
  in a way nothing here is about. Giving the handler a diagnostics handle is plumbing this ticket
  did not ask for, so it is recorded here and not done.

The clear costs one write per page rather than one per record, because `#clearStatus` zeroes
`#lastStatusWidth` and every later record of the page returns at `yieldLine`'s guard. That is the
cadence ticket 23's coalesced redraw already established, so the pair is one erase and one draw per
page.

`yieldLine` deliberately schedules **no** redraw of its own. A page's records have already scheduled
one — `record()` runs before the first of them reaches stdout — and the writes that have not are a
`warning` line, answered by ADR-0015 §4's 1 Hz timer, and the trailer, after which there is nothing
to draw. An earlier revision did schedule one, and it cost a wasted draw at the trailer: `#line`
wrote the summary and left a redraw owing, so ticket 23's `#finishLine` drew a status line that the
very next statement erased.

Ticket 23's property is unaffected. On the `--limit 1` run it measured, the records schedule a
redraw that never gets its turn, `yieldLine` finds a width of zero at the trailer and leaves the
debt standing, and `#finishLine` draws it exactly as before.

The erase is unconditional rather than gated on stdout being a TTY. ADR-0015 §2 puts the detection
on stderr's own descriptor and nowhere else, and honouring that literally costs one wasted stderr
write per page when stdout is redirected. §2's `pd deals list > out.ndjson` is now the case the
erase is wasted on rather than a precondition for the status line working, and the ADR's assumption
list records the change.

Six tests. Four in `src/lib/output/ndjson-writer.test.ts` record both channels into one log, because
the defect is an ordering between them: no stdout line follows a parked status line, a page of 500
records costs one clear, and stdout stays byte-identical to a run with no diagnostics attached —
once through the NDJSON path and once through `--pretty`. Two in `src/lib/output/diagnostics.test.ts`
cover the guard: byte-silent on a machine run, and a no-op with no status line on screen. The
erase's shape is named once as `isStatusClear` in `test/support/ndjson.ts`, because both files
count erasures.

595 tests pass, `tsc --noEmit` and `eslint .` clean.

**2026-08-19 — verified against the live account.** The same invocation this ticket was written
from, `pd deals list --limit 1 --fields custom_fields`, captured through a pseudoterminal so the
status line renders as it does for a human. The bytes around the record line now read:

```
\rpd: 0 records, 1 requests, 0.3s, gate 20/5 per 2s, concurrency 4\r                    \r{"type":"record",…
```

The carriage return, the run of spaces and the second carriage return between the status text and
the record line are `yieldLine`. The record starts on a cleared line, and nothing is left in
scrollback — against the transcript in ticket 23's `## Observed`, where the status text and the
record shared a line. Nothing was recorded to the repository; `.scratch/live/` is ignored and the
evidence is this paragraph.

A multi-page walk measures the cost claim. `pd deals list --limit 1200` — three pages, three
requests, 1200 records — wrote **four** erase sequences and four status draws. Not 1200: the guard
on `#lastStatusWidth` holds at the scale it was written for, one erase per page plus the trailer's.
The whole capture contains no record written onto a parked status line.
