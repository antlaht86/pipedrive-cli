# 06 — Record the public-repository decision and correct every normative document

**What to build:** a reader who arrives at any current document learns that the repository is public
and clonable by anyone, and never meets a sentence that tells them otherwise. The decision is
recorded once, as a decision record, and every accepted record it overturns points at it.

**Blocked by:** None — can start immediately.

**Status:** done

The decision record is the centre of the ticket. It supersedes the testing record's rule that the
repository must stay private, and the distribution record's section that makes the private clone the
boundary on who can obtain `pd`. It has to re-answer, in its own words, the questions those sections
were silently answering:

- **Who may obtain the tool.** Previously whoever had a clone, meaning colleagues. Now anyone.
- **Whose API budget a run spends.** Each user brings their own token and their own daily budget, so
  the shared-budget argument narrows to the company account rather than to every run.
- **What the clone boundary protected, and what replaced it.** Ticket 01 moved the live recording to
  an ignored directory, so the boundary now protects nothing and becomes an ordinary install step.
- **Whether recorded fixtures may ever return to version control.** The record on the record interior
  already says real CRM data is not to be committed; say whether that is now permanent.

The historical records of finished efforts — the design spec and the closed release ticket — also
state that the repository stays private. Leave them alone: they are accounts of what was decided
then, not standing rules. Say so in the new record, so a later reader knows the omission is a
decision rather than an oversight.

- [x] A new decision record exists, `Status: accepted`, naming every section it supersedes
- [x] It answers all four questions above in its own prose
- [x] It states that the historical design spec and closed tickets are deliberately left alone
- [x] The testing record's private-repository rule and the distribution record's clone-boundary
      section each carry a pointer to the new record
- [x] The testing record no longer claims the live suite's signal is a git diff of a committed
      fixture — ticket 01 made that a `git diff --no-index` between two recordings
- [x] `AGENTS.md` no longer tells the reader to clone a private repository, and its install text is
      true for someone with no prior access
- [x] `bun run build` embeds the corrected contract and `pd docs` prints it
- [x] `CONTEXT.md` gains a glossary entry for **recording**, distinguishing it from a fixture and
      linking the new record
- [x] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green

## Comments

**2026-08-19 — shipped: [ADR-0031](../../../docs/adr/0031-the-repository-is-public.md).** The
repository is public and the clone is not an access boundary. The record answers the four questions
in its own prose: anyone may obtain `pd` (§1); a run spends the *caller's* company account, which
scopes the shared-budget argument to one account rather than to `pd`'s users in aggregate (§2); the
clone boundary protected recordings on a tracked path and ticket 01 removed the path, so an ignored
directory replaces it mechanically (§3); and recorded fixtures never return to version control,
permanently and independently of visibility, confirming ADR-0029 (§4). §5 states that the design
spec and the closed release ticket are deliberately left saying "private", because they are accounts
of what was decided then.

The supersede pointers use the existing italic-note convention rather than rewriting the bodies:
ADR-0019 §10 and its "must stay private" consequence, ADR-0019 §9's git-diff signal (amended, not
superseded — the diff is now `git diff --no-index` between two recordings), ADR-0021 §9, §1's "the
repository is the access control" sentence, and the two Consequences bullets that promoted the
privacy constraint. Both records gain a `Superseded in part by:` header line.

`AGENTS.md` drops the word "private" from its clone instruction; the rest of the install text was
already true for a stranger. `CONTEXT.md` gains **recording**, contrasted with **fixture** on three
axes: invented versus real, tracked versus ignored, and what each one is for.

The binary-exclusion gate's shrunken coverage is named in ADR-0031 §3 and left to ticket 08.

Verified: `bun run build` then `pd docs` equals `AGENTS.md`, `bun test` 601 pass, `bun run gates`,
`bun run typecheck` and `bun run lint` all green.

**2026-08-19 — two-axis review, ten findings fixed.** The Standards axis caught the house style: the
back-pointer field is `Partly superseded by:`, sits immediately after `Date:`, and comes with
`Status: accepted, partly superseded`. Both records now carry that instead of an invented
`Superseded in part by:` appended last. The `***bold-italic***` supersede notes became plain italic
paragraphs, the struck-through consequence bullets took ADR-0001's `~~struck~~ **Corrected by …**`
form, ADR-0021's stale `Confirms: ADR-0019 §10` header line gained an inline italic correction in
ADR-0018's style, and ADR-0031's invented `Leaves standing:` verb became a second `Confirms:`.

The Spec axis caught three substantive things. ADR-0019 §9's body still literally said the suite
"writes fixtures" and does not assert equality "against the committed fixtures" — the italic note
reinterpreted it but the sentence survived, so the sentence itself is now struck and corrected in
place. ADR-0031 §2 had grown a new sentence attributing the live suite to the maintainer's real
account, which is precisely the kind of statement ticket 07 exists to remove; it is rephrased to
name no account. And §3 called the tracked fixture document "permanently empty", which settles a
question ticket 08 is supposed to decide; it now describes the state and hands the decision on.

Two smaller corrections: §5 said "two finished-effort documents" when the design effort states it in
three files, so it names the directory instead; and this map's progress line called 04 and 05 open
when both are marked superseded.

One judgement call declined. The reviewer noted that "the recorder writes to an ignored path"
is restated about eight times across the four documents. Each restatement sits in a supersede note
that has to stand alone — a reader arriving at ADR-0021 §9 should not have to follow a link to learn
why the section is dead — so the duplication is the convention working, not a smell.

Re-verified after the fixes: `bun run build` then `pd docs` equals `AGENTS.md`, `bun test` 601 pass,
`bun run gates`, `bun run typecheck` and `bun run lint` all exit 0.
