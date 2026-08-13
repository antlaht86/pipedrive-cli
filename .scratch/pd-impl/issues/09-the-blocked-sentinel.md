# 09 — The `blocked` sentinel

**What to build:** Pipedrive's Cloudflare layer blocks the company's `api_token` traffic once. `pd` records it, and for the next fifteen minutes every invocation on that credential refuses immediately with **zero HTTP requests**, `blocked`, exit 3. An agent looping `pd` fifty times gets one block, not fifty fresh retry caps. Nothing in the flag surface can turn it off.

**Blocked by:** 08

**Status:** ready-for-agent

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

- [ ] A Cloudflare block writes the sentinel under the credential's cache directory
- [ ] While live, every invocation on that credential exits 3 with `blocked` and dispatches zero requests
- [ ] The sentinel expires after 15 minutes, verified under the injected clock
- [ ] `pd cache clear` deletes the cache subtree but preserves the sentinel
- [ ] `--no-cache` does not bypass the sentinel
- [ ] No flag or environment variable overrides it
- [ ] An unparseable sentinel is treated as absent and the run proceeds normally
- [ ] `pd cache info` reports the sentinel and its remaining life
