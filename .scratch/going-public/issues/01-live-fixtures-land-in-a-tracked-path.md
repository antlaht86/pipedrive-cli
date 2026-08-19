# 01 — The live recorder writes real CRM data into a tracked path

**Blocked by:** None — can start immediately.

**Status:** done

## What happens

`bun run live` records the response bodies of a real Pipedrive account and writes them into
`fixtures/live/responses.json`, which is a tracked file. The recorded bodies hold real deals, real
organisation names, real amounts and real owners. The testing strategy defines the suite's signal as
the git diff of that file, so committing the recording is the intended workflow, not an accident.

Today the file holds only the canary placeholder and an empty fixture list, and no recording has ever
been committed — the whole git history contains exactly one blob at that path and it is the canary.
So the repository is clean right now.

## What I expected

For the repository to be publishable, no workflow may put customer data on a path that a `git add`
can reach. Right now the safety property is "nobody has run the recorder and committed it yet",
which is a habit, not a mechanism.

## Steps to reproduce

1. Put a Pipedrive token on the normal credential chain.
2. Run `bun run live`.
3. Read `fixtures/live/responses.json` — it now holds recorded bodies from the real account.
4. Run `git status` — the file is modified and stageable.

## Additional context

The distribution decision records considered and declined three escapes: a second private repository
for the fixtures, sanitising at record time, and ignoring the directory. The third was declined
because an ignored directory produces no git diff and therefore no signal, and because the replay
gate in CI has nothing to serve from untracked files. A public repository needs a fourth answer, and
that answer is a decision record of its own, not a `.gitignore` line.

The record on the record interior states that the project owner declined the recording outright and
that real CRM data is not to be committed under any of the arrangements previously considered. If
that is the settled position, this ticket is about making the recorder agree with it mechanically.

## Comments

**2026-08-19 — the goal is a clonable repository.** The reporter wants to share `pd` so that anyone
can clone and build it. That removes the option of leaving this as a habit: with a wider clone
audience the recorder must be unable to stage customer data, not merely unlikely to.

Three answers are open, and picking one is the work:

- **Retire the recorded fixture.** The record on the record interior already says real CRM data is
  not to be committed. If the live suite keeps only its drift check and reports the drift some other
  way, the tracked path disappears and so does the problem. Cost: the git diff stops being the
  signal, and the replay gate in CI loses its source.
- **Record into the ignored directory.** `.scratch/live/` is already ignored and already holds real
  run output. Cost: the previously declined objection stands — an ignored file produces no diff.
- **Sanitise at record time.** Previously declined because a sanitiser must be trusted on every
  field forever. A clonable repository makes one missed field public and permanent, so this option
  is weaker now, not stronger.

**2026-08-19 — shipped: the recording moved to the ignored directory.** `scripts/live.ts` now writes
to `.scratch/live/responses.json`, which `.gitignore` already covers. No `git add` reaches the
recording, so the public repository cannot acquire customer data by anyone forgetting the rule.

The drift signal survives the move. An ignored path has no index entry, so `git diff` against HEAD
had nothing to compare; the recorder now keeps the previous recording, writes the new one, and
prints `git diff --no-index` between the two. `--no-index` exits 1 for "the files differ", which is
the interesting outcome rather than a failure, so only exit 2 and above are treated as git failing.

`fixtures/live/responses.json` stays tracked and stays the canary with an empty fixture list. It is
what the release gates inspect: the credential scan needs a fixture tree, and the binary-exclusion
gate greps `dist/pd` for the canary string. Nothing writes to it any more.

Verified: `bun test` 601 pass, `bun run gates`, `bun run typecheck`, `bun run lint` all green.

The skeleton option was considered and not taken. A tracked file holding key paths and value types,
with the values dropped, would keep a real `git diff` signal — but its safety would depend on a
serialiser being correct forever, which is the same trust model the sanitiser option was declined
for. Worth revisiting only if the ignored-path diff proves too weak in practice.

The README's live-suite paragraph is updated here, because it described the mechanism this ticket
changed. Only the mechanical facts moved: the path, the ignored directory, and the `--no-index`
diff. The framing sentence that named the private repository as the access boundary is gone with
them, but the wider privacy argument is untouched.

Consequence for ticket 02: the testing record still claims the signal is a git diff of a committed
fixture, and the distribution record still rests on the clone being an access boundary. Fixing that
prose belongs to 02, which this ticket unblocks.
