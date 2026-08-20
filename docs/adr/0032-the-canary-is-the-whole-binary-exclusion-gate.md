# ADR-0032: The canary is the whole binary-exclusion gate

Status: accepted
Date: 2026-08-20
Deciding input: the gate's coverage shrank as a side effect of moving the recorder, and a gate whose remaining value is undocumented stops meaning anything
Deciding ticket: [08 — The binary-exclusion gate and the permanently empty fixture document](../../.scratch/going-public/issues/08-the-binary-exclusion-gate-and-the-empty-fixture-document.md)
Supersedes: [ADR-0029](0029-the-record-interior-passes-through.md)'s consequence that `fixtures/live/responses.json` stays empty and the fixture-tree credential gate stays
Supersedes: [ADR-0019](0019-testing-strategy.md) §10's "no credential-shaped string exists anywhere in the fixture tree" CI gate
Closes: [ADR-0031](0031-the-repository-is-public.md) §3's open question about the tracked fixture document and the weakened binary-exclusion gate
Confirms: [ADR-0021](0021-distribution-build-from-source.md) §8 — the published artifact still carries no recording, and that is still checked against the built binary

## Context

[ADR-0019](0019-testing-strategy.md) §10 built two CI gates around a tracked fixture tree. One
grepped every file in the tree for credential-shaped strings. The other read the tree, built a set of
byte needles from it — the canary string, each raw file, each compacted document, each compacted
response, each response body — and failed the release if any needle appeared in the built binary.

Both gates were designed when `fixtures/live/responses.json` was a tracked file that
`bun run live` overwrote with response bodies from a real account. Ticket 01 moved the recorder's
output to `.scratch/live/responses.json`, which `.gitignore` covers.
[ADR-0031](0031-the-repository-is-public.md) §4 made that permanent: no recording is ever committed,
whatever the repository's visibility.

What is left in the tree is one tracked file holding the canary string and an empty fixture list.
The credential scan therefore scans a file that contains no credentials and cannot come to contain
any. The needle set reduces to a single needle — the canary — because every other needle is derived
from fixtures, and there are none. Two error paths, "fixture tree is empty" and "no live fixture
document found", guard a file that nothing writes to.

The risk the gates existed for did not disappear. It moved. A recording still exists, on the machine
of whoever ran `bun run live`, in a directory that sits inside the repository working tree next to
the sources `bun build` reads. A build taught to embed it would still leak real CRM data into a
binary. The tripwire is worth keeping; what is not worth keeping is a tripwire that must read a
permanently empty file to arm itself.

## Decision

### 1. The canary is the needle, and it comes from the constant

`FIXTURE_CANARY` is a compile-time constant in `scripts/release-gates.ts`. `bun run live` stamps it
into every recording it writes, because the recorder builds its output with `fixtureDocument()`.
The binary-exclusion gate greps the built binary for that constant and nothing else.

No file is read to arm the gate. `inspectFixtureTree`, `FixtureInspection`, the raw-file and
compacted-document and response-body needles, and the two tree-shaped errors are deleted.

**What the gate proves after this record:** no build output contains a recording produced by
`bun run live`. That is the whole property, and it is the property that matters, because the
recorder is the only thing in this repository that ever holds real CRM data.

**What it stopped proving:** that no *arbitrary* response body is embedded. A body pasted into a
source file by hand, or captured by some future tool that does not stamp the canary, passes this
gate. That was already true the moment the tree went empty; this record states it instead of leaving
it to be inferred from an empty JSON array.

The needle is a constant in a script that `bun build` never reaches — the binary's entrypoint is
`src/cli.ts` — so the gate cannot trip on its own definition.

### 2. The tracked fixture document is deleted, not preserved empty

[ADR-0029](0029-the-record-interior-passes-through.md) said `fixtures/live/responses.json` stays
empty and called a gate over an empty tree cheap. It was cheap. It was also the last reader of a
file that no writer writes, and keeping it meant keeping tree-scanning code to justify the file and
keeping the file to justify the tree-scanning code.

The file is deleted and the `fixtures/` directory goes with it. Nothing else read it: the replay
seam serves invented fixtures defined in `test/support/`, and always did.

This is a third answer to the ticket's question rather than either one it offered. The tripwire
survives; the document does not.

### 3. The fixture credential scan is removed, not relocated

It existed to catch a token recorded into a fixture that was about to be committed. Nothing is
committed any more, so in CI it scans an empty tree and reports success about nothing.

Moving it to record time — scanning `.scratch/live/responses.json` as `bun run live` writes it — was
considered and declined. Three reasons, and the third is the decisive one:

- The recorder never records request headers, which is where a token would appear. A test asserts it.
- Pipedrive does not echo the API token in a response body, and the recorder stores bodies only.
- A recording from a real account is **full** of 40-hex custom-field codes, which is exactly the
  shape the bare-token detector matches. The existing `allowedFieldHashes` machinery exists to
  suppress that false positive by cross-referencing a recorded field schema. Against a real account
  it would be one missing `…Fields` response away from blocking a hand-invoked recorder that costs
  real budget to re-run. A gate that fails on correct input, on the one command a human runs by hand,
  is worse than no gate.

`credentialLeak`, `allowedFieldHashes`, `fixtureCredentialGate`, `fixtureFiles` and the field-schema
schemas that fed them are deleted.

### 4. `bun run gates` requires a binary path

With the fixture credential gate gone, the no-argument invocation had nothing left to check. It now
prints usage and exits non-zero rather than succeeding silently.

The CI suite leg's bare `bun run gates` step is removed. Both binary legs keep
`bun run gates dist/pd`, which is where every remaining gate lives.

## Consequences

- **The `fixtures/` tree no longer exists.** `CONTEXT.md`'s glossary said a fixture is "tracked under
  `fixtures/`"; it is corrected to `test/support/`, which is where invented fixtures have actually
  lived all along.
- **[ADR-0019](0019-testing-strategy.md) §10's gate table loses a row.** The fixture-tree credential
  gate is gone. The artifact row stays and is narrowed: the built binary is checked for the canary.
- **`bun run gates` is a binary gate and nothing else.** README's develop block is corrected — it
  described the command as "fixture credential gate".
- **`pd` gains no code change.** Every edit is in `scripts/`, CI configuration and documents. The
  shipped binary is byte-identical.
- **`fixtureDocument`, `serializeFixtureDocument`, `RecordedFixture` and `FIXTURE_CANARY` stay in
  `scripts/release-gates.ts`.** `scripts/live.ts` imports the first three, and reaches the canary
  through `fixtureDocument()`, which stamps it. The recording format and the canary that stamps it
  are the gate's own subject, so they stay beside the gate.
- **A future tool that captures real data must stamp the canary to be covered.** This is the one
  standing obligation this record creates, and it is cheap: build the document with
  `fixtureDocument()`.
