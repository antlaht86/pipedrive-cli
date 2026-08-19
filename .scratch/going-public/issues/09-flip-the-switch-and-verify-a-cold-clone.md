# 09 — Flip the switch and verify a cold clone

**What to build:** somebody with no prior access to this repository can find it, clone it, build
`pd`, and run it against their own Pipedrive account, following only what the repository says.

**Blocked by:** 07, 08

**Status:** ready-for-human

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
- [ ] A clone into an empty directory builds with `bun install` and `bun run build`, with no step the
      README omits
- [ ] `pd --version` reports the stamped version from that clone
- [ ] `pd auth status` tells a user with no credential what to do about it
- [ ] Continuous integration still passes on the public repository
- [ ] No file in the clone claims the repository is private
