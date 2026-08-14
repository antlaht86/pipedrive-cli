# ADR-0028: The sentinel's write site, its expiry, and what it does not stop

Status: accepted
Date: 2026-08-14
Deciding ticket: [The `blocked` sentinel](../../.scratch/pd-impl/issues/09-the-blocked-sentinel.md)
Extends: [ADR-0010](0010-budget-guard.md) §6, §7 — the sentinel's mechanics, its expiry and the two things that remove it
Extends: [ADR-0027](0027-the-stale-schema-refetch-the-generalised-refresh-and-the-local-cache-commands.md) §3 — the filename that ADR reserved, whose contents this one fixes

## Context

[ADR-0010](0010-budget-guard.md) §6 and §7 decided the sentinel: on a `blocked`
outcome `pd` writes a file under the credential's cache directory, every
invocation for fifteen minutes refuses with zero requests, no flag overrides it,
`pd cache clear` spares it and `--no-cache` does not reach it.

Four questions it does not answer would each be settled by accident otherwise,
and three of them are visible to a caller.

The sharpest is the write site. "On a `blocked` outcome, `pd` writes a sentinel"
is ambiguous between *when Pipedrive's edge refuses a request* and *whenever a
run ends in `code: "blocked"`* — and the second reading has a failure mode that
destroys the fifteen-minute bound.

## Decision

### 1. The sentinel is written where the block is recognised, never where it is reported

`guardedFetch`'s 403 branch calls a callback the prologue supplies, at the
instant `looksLikeHtml` identifies a Cloudflare page and before the `PdFailure`
is thrown. Nothing downstream — not the client wrapper, not the writer's `error`
trailer — writes it.

The write itself reuses [ADR-0005](0005-cache-design.md) §6's mechanics, which
ADR-0010's consequences hand to the sentinel unchanged. Those primitives — the
temp file plus `rename`, the `0600`, the `0700` directory — now live in one
module both the store and the sentinel import. §1's separation is about the
store's *surface*, which is keyed by a closed union of eight entry names the
sentinel is not one of; it was never an argument for writing the same four
`node:fs` wrappers twice.

The reason for the write site is the bound. A refusal *from* the sentinel makes no request, so it
never enters `guardedFetch`; if the write hung off the reported outcome instead,
an agent looping `pd` would push `blocked_at` forward on every refusal and
fifteen minutes would become forever. ADR-0010 §7 names exactly two removers,
the expiry and a human, and the second would have become the only one.

The callback is a `() => void` rather than a store because `guardedFetch` must
not learn what a credential is: the sentinel is keyed by the token's
fingerprint, and the gate is constructed before any token is resolved. This is
also why the write cannot live in `CacheStore` — that store is keyed by the
closed `CacheEntryName` union and is built only by the cached-resource command,
while a blocked `pd deals list` must record the block just the same.

### 2. The reader performs the expiry, and the expiry is a delete

`remaining()` returns `undefined` for a sentinel past its fifteen minutes **and
unlinks the file**. ADR-0010 §7 calls the expiry one of the two things that
remove the sentinel, and the guard is the only reader that *acts* on the answer,
so it is the only one that can carry out the removal without a background task
`pd` does not have. The first data command after the block ends therefore both
runs and tidies up.

`pd cache info` reads the same file and deliberately does **not** delete: it is
a reporter (§5 below), and a command that silently mutated the state it exists to
describe would make two runs of it disagree. A spent sentinel it meets before any
data command has run is reported with `expires_in_seconds: 0` — present, and
stopping nothing.

Both go through one function, `readSentinel`, which reads and decides and does
nothing else. Two parses of the same bytes would eventually disagree about
whether a block is in force, and the disagreement would surface as `pd cache
info` describing a refusal that did not happen.

The life is a **half-open** interval: live while the age is at least zero and
strictly less than fifteen minutes. A closed upper bound would leave one
millisecond during which the block is in force with zero seconds left, and the
refusal would offer to try again "in 0 minute(s)". A clock that has gone
backwards leaves a negative age, and that is treated as expired rather than as
blocked forever — the same direction [ADR-0005](0005-cache-design.md) §6's store
reads a negative entry age in. The unlink is best effort: losing the race to a
concurrent `pd` is a file that is already gone.

### 3. The remaining life is prose and `details`, never `retry_after_seconds`

`blocked` is `retry: "not_today"`, and [ADR-0001](0001-error-model-and-exit-codes.md)
puts `retry_after_seconds` only on `retry: "after"`. The refusal therefore names
the minutes left in its `message` and repeats them in `details.remaining_seconds`,
alongside `details.source: "sentinel"` — which is ADR-0010 §6's requirement that
`details` record the block came from memory rather than from a fresh response,
and which per ADR-0001 may not be branched on.

Putting a countdown in the field an agent waits on would invite exactly the
wait-and-retry loop the sentinel exists to prevent. The answer to `blocked` is
not "in nine minutes"; it is "stop, tell a human".

### 4. The sentinel stops the commands that make requests, and only those

The check sits in `commands/prologue.ts`, after credential resolution and before
the client is built. Every command that reaches Pipedrive passes through it, so
"zero HTTP requests while the block is live" is a property of one file rather
than a rule five command modules must remember.

The three commands [ADR-0009](0009-command-surface-and-manifest.md) §8 puts
outside the grammar — `pd auth status`, `pd cache info` and `pd cache clear` —
do not pass through it and keep working. That is not an oversight to be closed
later. They make no request, so refusing them protects nothing; and `pd cache
info` is the **only** way a human sees the sentinel at all
([ADR-0010](0010-budget-guard.md) §7). A block that took away the command that
explains the block would leave a refusal with no explanation anywhere.

`--version` is in the same position for the same reason.

### 5. A broken sentinel is reported, not hidden and not deleted

ADR-0010's consequences make an unparseable sentinel absent, which fails open.
Two mechanics follow and are recorded rather than argued.

The file is **left on disk**: it is the one artefact a human debugging a corrupt
sentinel has to look at, and the guard already ignores it. And `pd cache info`
reports it as `readable: false` rather than giving it an age, for the reason
ADR-0027 §"Consequences" gave the same marker on a cache entry — an age would
describe a block that is not in force.

## Consequences

- **The fifteen minutes is a bound, not a wish.** It is measured from the block
  and cannot be extended by meeting it. The one way to lengthen a block is to
  meet a second one.
- **`src/lib/cache/files.ts` is new**, and `store.ts` now imports its `node:fs`
  wrappers rather than declaring its own. The behaviour is unchanged; what moves
  is where ADR-0005 §6's mechanics are written down.
- **`guardedFetch` gains an option and no knowledge.** `onBlocked` is the fourth
  thing that module takes and the first that is a notification rather than a
  dependency; it stays ignorant of credentials, paths and the cache.
- **`pd cache info` gains `expires_in_seconds` beside `age_seconds`, and
  `readable: false` for a sentinel `pd` would ignore.** Both are fields on a
  command ADR-0009 §8 already puts outside the NDJSON grammar, so no line shape
  and no `code` moves and `manifest_version` does not move either.
- **A test that meets the block writes a real file.** The end-to-end suites that
  exercise a Cloudflare 403 need a cache home they own and delete, or the
  sentinel outlives the test and refuses the next one. That is the correct
  behaviour being inconvenient, not a reason for a test-only bypass
  ([ADR-0019](0019-testing-strategy.md) §5 forbids one).
- **Ticket 16 inherits a documentation duty.** `AGENTS.md` and the manifest must
  say that `blocked` can be reported without a request having been made, because
  an agent reading `requests: 0` beside an error will otherwise read it as a bug.
