# 09 — The `blocked` sentinel

**What to build:** Pipedrive's Cloudflare layer blocks the company's `api_token` traffic once. `pd` records it, and for the next fifteen minutes every invocation on that credential refuses immediately with **zero HTTP requests**, `blocked`, exit 3. An agent looping `pd` fifty times gets one block, not fifty fresh retry caps. Nothing in the flag surface can turn it off.

**Blocked by:** 08

**Status:** done

Normative: ADR-0010 §7 (the budget guard), ADR-0005 (cache mechanics), ADR-0001 (`blocked` variant).

Notes for the implementer:

- This is **the only piece of cross-invocation state in `pd`**, and it is a Cloudflare question rather than a budget one.
- On a `blocked` outcome, write a sentinel under the credential's cache directory. While it is live, every invocation for that credential refuses immediately: `blocked`, exit 3, `retry: "not_today"`, zero HTTP requests.
- It expires after **15 minutes**.
- **There is no override flag, in any form.** The one company-wide safety stop has no documented escape hatch.
- **`pd cache clear` preserves it** — it deletes the subtree *minus* the sentinel. **`--no-cache` does not bypass it.** An ordinary agent recovery reflex must not walk back into the block.
- Only the expiry and a human deleting the file remove it.
- An **unparseable sentinel is treated as absent**.
- `pd cache info` reports the sentinel alongside the entry ages, so a request-free refusal is explicable.

- [x] A Cloudflare block writes the sentinel under the credential's cache directory
- [x] While live, every invocation on that credential exits 3 with `blocked` and dispatches zero requests
- [x] The sentinel expires after 15 minutes, verified under the injected clock
- [x] `pd cache clear` deletes the cache subtree but preserves the sentinel
- [x] `--no-cache` does not bypass the sentinel
- [x] No flag or environment variable overrides it
- [x] An unparseable sentinel is treated as absent and the run proceeds normally
- [x] `pd cache info` reports the sentinel and its remaining life

## What shipped, and what it changed

`src/lib/cache/sentinel.ts` is the whole of it: the file format, the fifteen
minutes, the refusal and the write. It sits beside the cache store and shares
nothing with it — not `CacheEntryName`, not `CacheStore`, not a TTL row — which
is how ADR-0010 §7's "nothing in the cache surface, read or write, reaches the
sentinel" stays true rather than remaining an intention.

Four questions the ADRs left open needed a ruling and are ratified as
[ADR-0028](../../../docs/adr/0028-the-sentinels-write-site-its-expiry-and-what-it-does-not-stop.md):

1. **The write hangs off `guardedFetch`'s 403 branch, not off the reported
   outcome.** A run refused from memory makes no request and so never reaches
   that branch — which is the only reason fifty looped invocations cannot push
   `blocked_at` forward and turn fifteen minutes into forever.
2. **The reader performs the expiry, and the expiry deletes the file.** Nothing
   else in `pd` visits it, so a dead sentinel would otherwise have `pd cache
   info` reporting a block that stops nothing.
3. **The remaining life rides in the message and in `details`**, never in
   `retry_after_seconds`: `blocked` is `retry: "not_today"`, and a countdown
   would invite the wait-and-retry loop the sentinel exists to prevent.
4. **`pd auth status`, `pd cache info` and `pd cache clear` keep working while
   blocked.** They make no request, and `info` is the only way a human sees the
   sentinel at all.

`src/lib/cache/files.ts` came out of the work rather than being planned: the
`node:fs` wrappers ADR-0005 §6 fixes — temp file plus `rename`, `0600`, `0700` —
were about to exist twice, once in the store and once in the sentinel.

`pd cache info` now parses the sentinel instead of reading its mtime, and
reports `age_seconds` with `expires_in_seconds`, or `readable: false` for one
`pd` would ignore. `guardedFetch` gained one option, `onBlocked`, and no
knowledge of credentials.

`test/deals-list.test.ts` gained a temporary `XDG_CACHE_HOME` per test: its
Cloudflare case now writes a real sentinel, and left pointing at the caller's
home that file would refuse the next test rather than the next invocation.
