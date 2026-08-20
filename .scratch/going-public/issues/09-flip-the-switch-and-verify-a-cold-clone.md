# 09 — Flip the switch and verify a cold clone

**What to build:** somebody with no prior access to this repository can find it, clone it, build
`pd`, and run it against their own Pipedrive account, following only what the repository says.

**Blocked by:** 07, 08

**Status:** ready-for-human — the cold-clone verification is done, 2026-08-20; the visibility
flip and the post-flip CI check are the human's two steps and are the only boxes left.

The visibility change itself is one setting, and it is the smallest part of the ticket. The work is
proving that the promise the repository now makes is true for a stranger, which nobody has ever
tested — every existing build was done by someone who already had the checkout, the tooling, and the
context.

Verification is a cold run, not a reading. Clone into an empty directory, follow the README's build
section exactly as written, and stop at the first instruction that assumes knowledge the reader does
not have. The credential step is part of this: a new user has no token on the chain, and `pd auth
status` is what should tell them so.

Note that the repository is also the only distribution channel. Publishing it does not add a channel;
it widens the audience for the one that exists.

- [ ] Repository visibility is public and the description says what `pd` is
- [x] A clone into an empty directory builds with `bun install` and `bun run build`, with no step the
      README omits
- [x] `pd --version` reports the stamped version from that clone
- [x] `pd auth status` tells a user with no credential what to do about it
- [ ] Continuous integration still passes on the public repository
- [x] No file in the clone claims the repository is private

## The cold run, 2026-08-20

Run against a `git clone` of the local repository into an empty directory, which holds exactly the
tracked files a stranger gets, and with `HOME` pointed at an empty directory so the developer's own
credential could not answer.

`bun install` and `bun run build` both succeeded with no step outside the README, and `dist/pd
--version` printed `1.1.0+g101f79d` — the off-a-tag form the README documents. Two gaps were found
and closed:

- **The build section named Bun without saying where to get it.** A reader who does not have Bun was
  pointed at `engines.bun` for a version floor and at nothing for the install. The section now links
  bun.sh.
- **`pd auth status` reported the absence and said nothing about it.** With no credential it printed
  `{"found":false,…}` and an empty `warnings` array, which tells a machine everything and a human
  nothing. The resolution chain already had the sentence — the `auth` error every other command
  fails with names all three tiers and the credentials path — and this command threw it away. It is
  now shared as `noCredentialAdvice` and written to stderr, in both output modes, whenever nothing
  resolved. The machine surface is untouched: one JSON object, exit 0, zero requests, per ADR-0012
  §5. Stderr is human prose and carries no version promise, so no ADR moved. `AGENTS.md` gains one
  line anyway, because it is the canonical contract and a new observable output on a named command
  belongs in it — stated there as text an agent should ignore, next to the unbounded-list warning
  that already sets that precedent.

The last box is scoped by ticket 06: `package.json`'s `"private": true` is the npm-publish flag
ticket 03 deliberately kept, and the "private" text under `.scratch/pd-cli-design/`, in the closed
release ticket, and in ADR-0019 §10 and ADR-0021 §9 is history behind a supersession banner. No
present-tense claim survives.

## What is left for a human

```bash
gh repo edit --visibility public \
  --description "pd — a read-only Pipedrive CLI for agent harnesses. GET requests only, NDJSON out."
gh run list --limit 5    # after the flip
```
