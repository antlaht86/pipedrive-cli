# Testing strategy against a shared live account

Type: grilling
Status: open

Blocked by: 12, 14, 17

## Question

How is `pd` tested without spending the company's shared daily token budget, and without a naive test
run being the thing that earns a Cloudflare block?

- **Which strategy.** Recorded fixtures replayed from disk, a live sandbox account, contract tests
  against the generated types alone, or some combination. Name what each one can and cannot catch —
  contract tests never catch a wrong `next_cursor`, and fixtures never catch Pipedrive changing a
  response.
- **Where the seam sits, and this is the constrained part.**
  [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) put **two** generated clients behind
  one `guardedFetch`, and locked point 7 puts every HTTP call through that one module. A replay layer
  that sits at a *client* lets v1 traffic escape it, so it must sit at the gate.
- **What guard state a test must be able to drive.** [ADR-0010](../../../docs/adr/0010-budget-guard.md)
  removed the token ledger, so there is no budget to fake — what is left is `--max-requests` and the
  `blocked` sentinel file, and the sentinel is deliberately unreachable from `--no-cache` and
  `pd cache clear`, so a test needs some other way to place and clear it.
- **The clock.** [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md) makes the burst gate, three
  strikes at ≤2 s each, and a 250 ms / 1 s / 4 s jittered 5xx backoff all timing behaviour. A
  retry-policy test that waits for real costs ~6 seconds each. Does the gate take an injectable clock,
  and does that count as testing seam or as production complexity bought for tests?
- **The cache is already a seam.** [ADR-0005](../../../docs/adr/0005-cache-design.md) specifies a keyed,
  version-stamped on-disk store. Does the replay layer reuse it, or is sharing them a false economy that
  couples two things that fail differently?
- **How many real calls are acceptable, and when.** Zero on every `bun test` run is the obvious floor.
  Whether a separate, explicitly-invoked live suite exists at all — and what it is allowed to touch —
  is the decision. Note research 01's asymmetry: a test that hammers a 429 to prove the retry path costs
  the whole company its API access.
- **Fixture provenance.** Recorded responses carry real CRM data and, if captured naively, the API token
  in a query string. What is redacted, and is that a manual discipline or a mechanical one?

Record as an ADR.
