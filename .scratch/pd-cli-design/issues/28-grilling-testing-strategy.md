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

## Context added while resolving other tickets

- **[ADR-0013](../../../docs/adr/0013-read-only-enforcement.md) §2 hands you two tests you do not get to skip**, because they enforce a safety property rather than catch a regression: a CI assertion that both generated clients contain zero non-GET operations after regeneration, and a unit test that drives a non-GET request through the single client and asserts the `write_blocked` error. You may decide how they are structured and where they run. You may not decide whether they exist. The same ADR makes the ESLint `no-restricted-imports` rule on `**/generated/**` a CI gate, so the lint step is not optional either.
- **[ADR-0014](../../../docs/adr/0014-distribution.md) §3 adds a third mandatory check and one question you do own.** The check: an ESLint ban on the `Bun` global and every `bun:*` import in `src/**`, CI-gated, because the shipped artifact targets Node ≥ 20 and the whole npm-package channel rests on that ban holding. The question: the test suite runs under Bun, but users run the bundle under Node — so decide whether tests execute against both runtimes, and whether anything tests the built bundle rather than the source. ADR-0014 §9's `unsupported_runtime` check and §5's version-stamp agreement between `pd --version` and the manifest's `pd_version` are both things only a test can keep honest. §6 also commits CI to a Windows runner beside the POSIX one — the `%LOCALAPPDATA%`/`%APPDATA%` path resolution is the only Windows-specific code in `pd` and the only thing that leg exists to protect.

- **[ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) hands this ticket two testable
  claims.** First, a non-TTY run emits exactly two things on stderr (§1) — testable as output, and the
  test must be able to lie about whether stderr is a TTY. Second, no unredacted query value or
  non-allowlisted header reaches stderr under `--verbose` (§6); that is a safety assertion belonging
  with ADR-0013's CI gates rather than in a snapshot test, and it is the second such gate this map has
  produced.
- ADR-0015 §4's status line refreshes on a ~1 Hz timer, which joins ADR-0011's gate and retry budgets
  in the set of timing behaviour a replay layer must be able to drive the clock for.

- **[ADR-0016](../../../docs/adr/0016-field-projection.md) §7 hands this ticket the highest-value
  single test in the map**: the same projection with and without the upstream `custom_fields`
  push-down must produce **byte-identical** output. That property is the only thing standing between
  an optimisation and a silent contract change, and it needs a fixture pair rather than a live call.
- Also testable from ADR-0016: an unknown top-level selector exits 2 **before any request is made**
  (§6), which is a test the HTTP layer must be able to assert was never touched.
