# Testing strategy against a shared live account

Type: grilling
Status: resolved

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

- **[ADR-0017](../../../docs/adr/0017-search-and-list-filtering.md) adds one fixture problem and three
  free tests.** The problem: §3's four search-hit schemas are `pd`'s own, and there is **no live record
  to diff them against** — a hit is a truncated projection the spec describes loosely and `pd` then
  renames and flattens, so a fixture is the only thing that can pin the shape, and a fixture recorded
  once will not notice Pipedrive widening the projection. Decide whether that is acceptable or whether
  the live suite has to re-record. The free tests, all offline and all costing zero requests: the
  minimum-term-length refusal, the `--filter-id` with `--ids` refusal, and `--sort-by` on a search
  command — each exit 2 with the HTTP layer asserted untouched, which is the same assertion ADR-0016 §6
  already needs. §9's `(record_type, id)` dedup key is a fourth, on a mixed `pd items search` fixture.

- **[ADR-0018](../../../docs/adr/0018-related-entity-expansion.md) adds three offline tests and no
  fixture problem**, because the decision was to add nothing: `--ids` with 250 ids issues exactly
  three requests; `--ids` with duplicate ids issues the same requests as without them; and a fixture
  where the API omits two requested ids produces exactly one `unmatched_ids` warning and exit 0. All
  three assert against the HTTP layer rather than against Pipedrive, so all three cost zero requests.

## Answer

Recorded in [ADR-0019](../../../docs/adr/0019-testing-strategy.md).

**Strategy.** Three layers, each with its blind spot named: offline unit tests over `pd`'s own logic
(cannot see a response body), fixture replay (cannot see Pipedrive changing), and a hand-invoked live
suite (sees nothing on a schedule, because nothing schedules it). Beside them sit the CI gates, which
are safety assertions rather than regression tests and fail hard.

**The seam.** Replay is installed at `guardedFetch`'s custom `fetch`, not at a client — so v1 `users`
traffic cannot escape it. The consequence that made this more than convenient: replay sits *below*
ADR-0013's non-GET refusal, so no test can accidentally test past the read-only property, and every
replay test re-executes the refusal path. It also gives ADR-0016 §6, ADR-0017 and ADR-0018 one shared
answer to "and no request was made" — the gate's dispatch count.

**Zero requests is mechanical.** The default gate is constructed with a transport that throws, so a
missing fixture fails a test instead of quietly making a live call. The failure mode of a suite that
drifts into hitting the network cannot occur.

**The clock.** Injected, alongside the transport, into the one module that already takes an injected
`fetch`. Six timing behaviours depend on it (ADR-0011's gate and both retry budgets, ADR-0015's 1 Hz
status line, ADR-0005's TTLs, ADR-0010's sentinel expiry); the retry test alone costs ~6 s of real time
and the TTL tests are untestable without it. Ruled a seam rather than production complexity: one extra
parameter, at a boundary that already exists for an unrelated reason, and nothing else in `pd` reads
the wall clock. Jitter is seeded from the same source, so backoff tests assert exact durations.

**Guard state.** No test-only flag and no test-only environment variable. Isolation runs entirely on
the `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` and `%LOCALAPPDATA%` / `%APPDATA%` overrides ADR-0005,
ADR-0012 and ADR-0014 already defined. The `blocked` sentinel is placed by writing the file and cleared
by deleting it — its unreachability from `--no-cache` and `pd cache clear` was about refusing an agent
a flag, never about hiding a file.

**Cache reuse: no.** Sharing them is a false economy, and the reason is that they are permitted to fail
in opposite directions — the cache is deliberately partial, TTL'd, version-stamped and credential-keyed,
every one of which is wrong for a fixture store that must never expire and must be keyed by request.
The cache is still exercised, by replay tests with a temp cache directory and the injected clock.

**Runtimes.** Suite under Bun; a short smoke leg runs the *built bundle* under Node 20 and LTS, plus
the Windows runner. That leg exists because the ESLint ban proves the source is `Bun.*`-free while
users run the bundle, and a bundler can reintroduce the gap. Three things are asserted on the bundle
only: ADR-0014 §5's `pd --version` / `pd_version` agreement, §9's `unsupported_runtime` refusal, and the
tarball contents.

**Live suite: yes, hand-invoked only** (user's decision). Never CI, never scheduled, never part of
`bun test`, read-only by construction through the same guarded client, with a `--max-requests` ceiling
it is alone in supplying by default. It runs against the **real company account** — a sandbox was
rejected because its custom-field schema, option ids and emptiness would pin a shape no real user meets.
Its output is a re-recording that leaves a git diff for a human, not a pass/fail, because a suite that
goes red when a colleague edits a deal is a suite nobody reads. It **never** tests a retry, a 429 or the
Cloudflare block — permanently, on research 01's asymmetry — which is the strongest single argument for
the fake clock.

**Fixture provenance: real CRM data, verbatim** (user's decision). Three consequences written into the
ADR rather than assumed: the repository being private becomes a load-bearing design property and cannot
be opened without a git-history rewrite; the package manifest uses an explicit `files` allowlist with a
CI gate on the packed tarball, so no fixture ever ships; and the credential is stripped mechanically
regardless — request headers are never recorded, and a CI gate greps the fixture tree for
credential-shaped strings. The user's decision was about CRM data and never about the token.

**Net surface: zero.** No flag, no environment variable, no line type, no warning kind, no error
variant, no exit-code change, and `manifest_version` does not move. Production cost is two injected
dependencies on `guardedFetch` and one injected TTY predicate on the diagnostics module.
