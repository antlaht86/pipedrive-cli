# ADR-0031: The repository is public, and the clone is not an access boundary

Status: accepted
Date: 2026-08-19
Deciding input: user direction — `pd` is to be shared, and the repository clonable by anyone
Deciding ticket: [06 — Record the public-repository decision](../../.scratch/going-public/issues/06-record-the-decision-and-correct-the-normative-documents.md)
Supersedes: [ADR-0019](0019-testing-strategy.md) §10 in full, and its "the repository must stay private" consequence
Supersedes: [ADR-0021](0021-distribution-build-from-source.md) §9 in full, and §1's "the repository is the access control" sentence; §1's build-from-source channel is untouched
Amends: [ADR-0019](0019-testing-strategy.md) §9 — the live suite's signal is a diff between two recordings on an ignored path, not a git diff of a committed fixture
Confirms: [ADR-0029](0029-the-record-interior-passes-through.md) — real CRM data stays out of version control, now permanently
Confirms: [ADR-0021](0021-distribution-build-from-source.md) §1 — build from source is still the only way to obtain `pd`, and this ADR changes the audience rather than the channel

## Context

Two accepted records made the repository's privacy load-bearing.
[ADR-0019](0019-testing-strategy.md) §10 made it a design constraint because recorded fixtures held
real customer data and git history keeps it. [ADR-0021](0021-distribution-build-from-source.md) §9
promoted that constraint: once the repository became the distribution channel, obtaining `pd` *was*
cloning, so the same sentence that protected the data also bounded the audience to colleagues.

Both arguments rested on one premise — that a recording of a real production account lives on a
tracked path. That premise is gone. Ticket 01 moved the live recorder's output to
`.scratch/live/responses.json`, which `.gitignore` already covers, and replaced the git-diff signal
with a `git diff --no-index` between the previous recording and the new one. No `git add` reaches a
recording any more. The audit behind the going-public map read all 86 commits and found that no
recording was ever committed: the one blob that has ever existed at the old fixture path is the
canary placeholder with an empty fixture list.

So the data argument no longer holds, and the audience argument was only ever the data argument
wearing a second hat. What is left is a decision the owner has now made: `pd` should be shareable.

## Decision

### 1. The repository is public, and anyone may clone it

The repository's visibility becomes public. Whoever finds it may clone it, read it, and build the
binary. There is no access list, no allowlist and no second gate.

**The distribution channel does not change.** ADR-0021 §1 stands whole: no npm package, no registry,
no release artifact, no installer. A user clones and runs `bun run build`. What changes is only who
that user may be. ADR-0021's consequence "`pd` has no audience outside this repository's access
list" is withdrawn along with §9; anything written for "a user who installs `pd`" now means what it
says, and no longer has to be read as "a colleague with a clone".

### 2. Whose budget a run spends, and why that is no longer an audience argument

Every run of `pd` spends the daily token pool of **the company account the resolved token belongs
to** — the caller's own company, not this project's. [ADR-0012](0012-authentication-and-credential-resolution.md)
makes the credential entirely the user's: `pd` reads a token from the caller's chain, writes none,
and has no credential of its own to lend. A stranger who clones `pd` brings their own Pipedrive
account, their own token and their own daily budget, and can exhaust nothing but their own.

The shared-budget reasoning that [ADR-0019](0019-testing-strategy.md) was built on is therefore not
weakened, only correctly scoped. It was never a statement about `pd`'s users in aggregate; it is a
statement about one company account, shared by everyone and every integration on it, which is why
the zero-request default, the request ceiling and the hand-invoked live suite all stay exactly as
they are. A wider audience adds users, not spenders of the same pool.

One consequence follows for the live suite. [ADR-0019](0019-testing-strategy.md) §9 keeps it
hand-invoked because a run costs a real account real budget; that reasoning is unchanged and now
reads naturally for any reader, because whoever runs `bun run live` runs it against the account
their own token points at, spends their own budget, and records their own data.

### 3. What the clone boundary protected, and what replaced it

It protected one thing: recorded response bodies on a tracked path. Ticket 01 removed the path, so
the boundary now protects nothing.

The replacement is mechanical rather than social. The recorder writes to an ignored directory, so a
recording cannot be staged, and the failure mode the boundary guarded against — somebody records and
commits — is unreachable rather than merely discouraged. Nothing writes to the tracked
`fixtures/live/responses.json` any more; it holds the canary string the release gates grep for and an
empty fixture list, and whether it keeps earning its place is ticket 08's question, not this
record's.

ADR-0021 §9's `.gitignore` refusal is reversed, and the reason it was refused is worth stating
because it was a good reason at the time: an ignored file has no index entry, so `git diff` against
HEAD had nothing to compare. The recorder now keeps the previous recording, writes the new one, and
diffs the two with `git diff --no-index`. The signal survives the move; what is lost is its history,
because an untracked recording exists on one machine and one machine only. That is accepted. The
replay gate is unaffected: it serves invented fixtures, and always did.

The binary-exclusion gate is weaker by construction now that the tracked fixture document is empty —
it has only the canary string to grep for. That is named here and left open; ticket 08 owns both it
and the fate of the document.

### 4. Recorded fixtures never return to version control

Permanently, and not as a consequence of the repository being public.

[ADR-0029](0029-the-record-interior-passes-through.md) records the project owner's decision that
real CRM data is not to be committed to this repository under any of the arrangements ADR-0021 §9
considered — the second private repository, the sanitiser at record time, and the tracked fixture
tree itself. That decision was made while the repository was still private, so publication does not
create it and could not reverse it. This record fixes it as permanent: **no recording is ever
committed, whatever the repository's visibility.**

The three declined escapes stay declined, and the public repository strengthens the case against the
sanitiser specifically: it must be trusted on every field forever, and one missed field is now
public, permanent, and indexed.

### 5. Historical documents are left as they are

Two finished efforts still say the repository stays private: the design effort under
[`.scratch/pd-cli-design/`](../../.scratch/pd-cli-design/map.md) — its spec, its map and the ticket
that grilled the testing strategy — and the closed release ticket
[`.scratch/pd-impl/issues/20-release-1-0-0.md`](../../.scratch/pd-impl/issues/20-release-1-0-0.md).

**They are deliberately not corrected.** They are accounts of what was decided and shipped at the
time, not standing rules, and rewriting them would destroy the record of a decision that was real
when it was made. The omission is a decision, not an oversight. A reader who meets "the repository
stays private" anywhere under `.scratch/pd-cli-design/` or in a closed ticket is reading history, and
this record is what holds instead.

The normative documents — the two decision records above, `AGENTS.md` and `CONTEXT.md` — are
corrected, because a reader arriving at those is being told what is true now.

## Consequences

- **[ADR-0019](0019-testing-strategy.md) §10 and [ADR-0021](0021-distribution-build-from-source.md) §9
  are superseded.** Both keep their `Status: accepted` history and gain a note pointing here. Nothing
  in either section is cited normatively any more.
- **[ADR-0019](0019-testing-strategy.md) §9's signal statement is corrected.** The live suite's
  output is still a re-recording a human reads as a diff, and still never a pass or a fail — but the
  diff is between two recordings on an ignored path, produced by `git diff --no-index`, not a git
  diff of a committed fixture.
- **The distribution decision is untouched.** Build-from-source stays the only channel. This record
  changes the audience, not the mechanism.
- **`pd` gains no code change at all.** No flag, no error variant, no warning kind, no manifest
  entry. The entire cost of this decision is documentation and repository settings.
- **`AGENTS.md` no longer names a private repository**, and its install text is true for a reader
  with no prior access: clone the public URL, install, build.
- **`CONTEXT.md` gains a term.** **Recording** joins the glossary, distinguished from a fixture,
  because the two are now different kinds of file living in different places under different rules.
- **The visibility switch is a separate act.** This record decides that the repository is public;
  ticket 09 performs the change and verifies a cold clone builds.
