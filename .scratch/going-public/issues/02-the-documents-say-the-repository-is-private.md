# 02 — Every distribution document says the repository is private

**Blocked by:** 01

**Status:** superseded

## What happens

The agent contract, the README and two decision records all build on the repository being private.
The distribution record makes it load-bearing: the repository is also the only distribution channel,
so "who has a clone" is the current access control on the tool itself. The testing record says the
repository must stay private because fixtures hold real customer data and history keeps them.

Flipping the visibility switch makes all of these documents factually wrong, and silently deletes an
access boundary that other decisions lean on.

## What I expected

Going public should be a recorded decision that supersedes the earlier ones and re-answers the
questions they answered: who may obtain the tool, what bounds the shared daily API budget once
anyone can build the binary, and what replaces the clone as the audience boundary.

## Steps to reproduce

1. Read the install line in the agent contract — it says to clone the private repository.
2. Read the live-suite paragraph in the README — it names the private repository as the access
   boundary for recorded response bodies.
3. Read the testing and distribution records — both state the repository must stay private.

## Additional context

Blocked by ticket 01 because the fixture question decides what the new record can honestly claim.
The documents to update are the agent contract, the README, and the two records, plus the design
spec section that states the repository cannot become public by flipping a setting.

## Comments

**2026-08-19 — the goal is a clonable repository.** The reporter wants others to clone and build
`pd`. The distribution channel itself does not change: build-from-source stays the only channel, and
the repository stays the channel. What changes is the audience, so the superseding record has to
re-answer only the questions that the clone boundary was silently answering:

- **Who may obtain the tool** — previously "whoever has a clone", meaning colleagues. Now anyone.
- **Whose API budget a run spends** — each user brings their own token and therefore their own daily
  budget, so the shared-budget argument narrows to the company account rather than every run.
- **What the audience boundary protects** — nothing, once the fixture question in ticket 01 is
  settled. The clone boundary stops being a safety mechanism and becomes an ordinary install step.

**2026-08-19 — superseded by 06.** This ticket was one context too small to hold: the decision
record, the supersede pointers, the agent contract and the glossary are one sweep over the same
documents. Ticket 06 carries all of it, and every acceptance question this ticket raised — who may
obtain the tool, whose budget a run spends, what the clone boundary protected — is an explicit
acceptance line there.
