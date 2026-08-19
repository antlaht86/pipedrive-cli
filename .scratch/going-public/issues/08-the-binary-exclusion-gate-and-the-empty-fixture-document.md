# 08 — The binary-exclusion gate and the permanently empty fixture document

**What to build:** the release gate that proves no recorded fixture is embedded in the binary either
does real work, or is gone. What it does today is neither stated nor decided.

**Blocked by:** 06

**Status:** ready-for-agent

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

- [ ] A decision is written down, in the testing record or a new one, naming what the gate proves
      after ticket 01 and what it stopped proving
- [ ] The code matches the decision — no vestigial inspection of a file that cannot change
- [ ] The credential scan is either justified in its new setting or removed with the rest
- [ ] `bun run gates` still fails a binary that embeds a recording, or the decision says why that
      check no longer exists
- [ ] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green
