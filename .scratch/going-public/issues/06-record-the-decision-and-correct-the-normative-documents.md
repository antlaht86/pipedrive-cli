# 06 — Record the public-repository decision and correct every normative document

**What to build:** a reader who arrives at any current document learns that the repository is public
and clonable by anyone, and never meets a sentence that tells them otherwise. The decision is
recorded once, as a decision record, and every accepted record it overturns points at it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

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

- [ ] A new decision record exists, `Status: accepted`, naming every section it supersedes
- [ ] It answers all four questions above in its own prose
- [ ] It states that the historical design spec and closed tickets are deliberately left alone
- [ ] The testing record's private-repository rule and the distribution record's clone-boundary
      section each carry a pointer to the new record
- [ ] The testing record no longer claims the live suite's signal is a git diff of a committed
      fixture — ticket 01 made that a `git diff --no-index` between two recordings
- [ ] `AGENTS.md` no longer tells the reader to clone a private repository, and its install text is
      true for someone with no prior access
- [ ] `bun run build` embeds the corrected contract and `pd docs` prints it
- [ ] `CONTEXT.md` gains a glossary entry for **recording**, distinguishing it from a fixture and
      linking the new record
- [ ] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green
