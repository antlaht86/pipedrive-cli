# 08 — The binary-exclusion gate and the permanently empty fixture document

**What to build:** the release gate that proves no recorded fixture is embedded in the binary either
does real work, or is gone. What it does today is neither stated nor decided.

**Blocked by:** 06

**Status:** done, 2026-08-20 — [ADR-0032](../../../docs/adr/0032-the-canary-is-the-whole-binary-exclusion-gate.md)

Ticket 01 moved the live recording to an ignored directory. The tracked fixture document is now
permanently the canary with an empty fixture list, so the gate's needles reduce to one string: the
canary itself. The credential scan over the fixture tree has nothing to scan, and the tree-is-empty
and no-document-found errors now guard a file that no longer changes.

The gate is not worthless — the canary is still a tripwire, and it would still fire if anyone taught
the build to embed a recording. But a gate whose coverage shrank by accident and whose remaining
value is undocumented is the kind of green tick that stops meaning anything. Decide which it is:

- **Keep it as a named tripwire.** Say in the release-gate code and in the testing record exactly
  what it now proves and what it no longer proves, and make the empty document's permanence explicit
  rather than incidental.
- **Retire it with the empty document.** Delete the tracked fixture document, the tree inspection and
  the needle machinery, and record why the property it guarded is now guarded by the recording living
  outside version control instead.

Whichever is chosen, the credential scan deserves the same question: it exists to catch a token
recorded into a fixture, and the fixtures no longer live in the tree.

- [x] A decision is written down, in the testing record or a new one, naming what the gate proves
      after ticket 01 and what it stopped proving
- [x] The code matches the decision — no vestigial inspection of a file that cannot change
- [x] The credential scan is either justified in its new setting or removed with the rest
- [x] `bun run gates` still fails a binary that embeds a recording, or the decision says why that
      check no longer exists
- [x] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green

## Outcome

A third answer, not either option as written: the tripwire survives and the document does not.
[ADR-0032](../../../docs/adr/0032-the-canary-is-the-whole-binary-exclusion-gate.md) records it.

- The needle is the `FIXTURE_CANARY` constant, read from code rather than from a file. `bun run live`
  stamps it into every recording, so the gate still fails a binary that embeds one — verified against
  a deliberately tainted copy of `dist/pd`.
- `fixtures/live/responses.json` and the `fixtures/` tree are deleted, along with the tree
  inspection, the raw and compacted needles, and the tree-is-empty and no-document errors.
- The credential scan is removed rather than relocated. ADR-0032 §3 gives the reasons, the decisive
  one being that a real recording is full of 40-hex custom-field codes and a record-time scan would
  block a hand-invoked recorder that costs real budget to re-run.
- `bun run gates` now requires a binary path; the CI suite leg's bare invocation is gone.
- **The last box is met in a changed form, and that is deliberate.** Bare `bun run gates` no longer
  exits 0 — it prints usage and exits 2, because ADR-0032 §4 left it with nothing to check and an
  exit-0 no-op is the meaningless green tick this ticket was filed about. The green command is
  `bun run gates dist/pd`.
- `bun test` 599 pass, `bun run gates dist/pd`, `bun run typecheck` and `bun run lint` all green.
