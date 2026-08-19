# Going public

Can this repository be made public? A QA session on 2026-08-19 audited the working tree and the whole
git history for private data.

## What the audit found

**The history is clean.** Across all 86 commits: exactly one blob has ever existed at
`fixtures/live/responses.json` and it is the canary placeholder with an empty fixture list. No API
tokens, no real email addresses, no home-directory paths, no internal links, no colleague names. One
file has ever been deleted and it held source, not data. Every Pipedrive-shaped record in the tree
comes from an invented generator; the sample custom-field keys are hand-patterned hex, and the two
real-looking field keys in the research notes are quoted from Pipedrive's public documentation. The
`.scratch/live/` directory on disk holds real run output but is ignored and untracked.

**So nothing leaks today.** The blockers are design and documentation, not spilled data.

## Tickets

- [01](issues/01-live-fixtures-land-in-a-tracked-path.md) — the live recorder writes real CRM data
  into a tracked path. The one hard blocker: the next recording plus a commit is a permanent leak.
- [02](issues/02-the-documents-say-the-repository-is-private.md) — the agent contract, the README and
  two decision records all state the repository is private, and the distribution record makes that an
  access boundary. Blocked by 01.
- [03](issues/03-no-licence-and-the-package-is-marked-private.md) — no `LICENSE`, and the manifest is
  marked private. Human decision.
- [04](issues/04-the-superseded-npm-scope-names-the-employer.md) — the employer's name survives as an
  npm scope in a declined distribution plan.
- [05](issues/05-the-budget-record-states-facts-about-the-company-account.md) — two records state
  operational facts about the real company account.

01 and 02 gate publication. 03 is required for publication to mean anything. 04 and 05 are
judgement calls that can be answered either way, but should be answered before the switch, not after.

## Goal, stated 2026-08-19

The reporter wants to share `pd` with other people and have the repository be clonable. The
distribution model does not change — build-from-source stays the only channel — but the clone stops
being an access boundary. That makes 01 and 03 mandatory and narrows what 02 must re-decide.

## Progress

- **03 done, 2026-08-19.** `LICENSE` holds MIT, copyright 2026 Antti Lahtinen; `package.json` gains
  `"license": "MIT"` and keeps `"private": true`.
- **01 done, 2026-08-19.** The live recorder writes to the ignored `.scratch/live/responses.json`,
  and its drift signal is a `git diff --no-index` between the previous recording and the new one.
  The tracked canary stays for the release gates. This unblocks 02.
- **06 done, 2026-08-19, superseding 02.** [ADR-0031](../../docs/adr/0031-the-repository-is-public.md)
  records the decision: the repository is public and the clone is not an access boundary. ADR-0019 §10
  and ADR-0021 §9 are superseded and point at it, ADR-0019 §9's git-diff signal is amended,
  `AGENTS.md` no longer names a private repository, and `CONTEXT.md` gains **recording**. The design
  spec and the closed release ticket are deliberately left as history. This unblocks 07 and 08.
- **02, 04 and 05 superseded** — 02 by ticket 06, and 04 and 05 by ticket 07. No hard blocker
  remains: what is left is the disclosure pass, the binary-exclusion gate, and the switch itself.

## The remaining work, resized

The first breakdown cut the documentation work into six document-sized tickets. Each was far smaller
than one context window, so the sequencing overhead exceeded the work. Rebuilt at roughly one full
context each:

- [06](issues/06-record-the-decision-and-correct-the-normative-documents.md) — the decision record,
  the supersede pointers, the agent contract and the glossary, as one sweep. Supersedes 02. **Done.**
- [07](issues/07-the-disclosure-pass.md) — the disclosure pass: the employer name and the facts about
  the company account. Supersedes 04 and 05. Blocked by 06, which opens the same records.
- [08](issues/08-the-binary-exclusion-gate-and-the-empty-fixture-document.md) — the binary-exclusion
  gate, whose coverage shrank by accident when ticket 01 emptied the tracked fixture document.
  Blocked by 06.
- [09](issues/09-flip-the-switch-and-verify-a-cold-clone.md) — the visibility change, and proving a
  stranger can clone and build. Blocked by 07 and 08.

06 has landed. 07 and 08 are independent of each other and are the frontier; 09 waits on both.
