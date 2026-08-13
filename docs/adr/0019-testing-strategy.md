# ADR-0019: Testing `pd` against an API it must not spend

Status: accepted
Date: 2026-08-12
Deciding ticket: [Testing strategy against a shared live account](../../.scratch/pd-cli-design/issues/28-grilling-testing-strategy.md)
Extends: [ADR-0013](0013-read-only-enforcement.md) §2 — the CI gate set grows from three to six, and the fixture tree gains two of its own
Extends: [ADR-0011](0011-concurrency-and-retry.md) — the gate and both retry budgets take an injected clock; no observable behaviour changes
Confirms: [ADR-0005](0005-cache-design.md) §6 and [ADR-0012](0012-authentication-and-credential-resolution.md) §3 — the existing `XDG_*` overrides are the whole test-isolation mechanism, so no test-only flag or environment variable is added

## Context

Every other ADR in this map decided what `pd` does. This one decides how anyone can know it still does
it — under two constraints that make the ordinary answer illegal.

**The API under test is shared and exhaustible.** Research 01 established that the daily token budget
belongs to the whole company account, that no header reports what is left of it, and — the sharper
fact — that hammering a 429 earns a Cloudflare 403 whose HTML body blocks every integration in the
company, not just `pd`. A test suite that talks to Pipedrive on every run is not merely slow or
flaky; it is a mechanism for one developer to take the CRM offline for everyone.

**Most of what `pd` promises is not a Pipedrive fact at all.** [ADR-0006](0006-validation-placement-and-rejection.md)
made the record schema `pd`'s own, [ADR-0002](0002-output-format.md) made the line grammar `pd`'s own,
and [ADR-0017](0017-search-and-list-filtering.md) §3 made the four search-hit shapes `pd`'s own. The
agent-visible contract is therefore almost entirely testable without a network — which is what makes a
zero-request default achievable rather than aspirational.

Two decisions in this ADR were the user's, because both have a cost outside the code:
a live suite exists but is invoked by hand only (§9), and recorded fixtures keep real CRM data
verbatim (§10).

## Decision

### 1. Three layers, and what each one cannot catch

Naming the blind spot is the point of the layering; a layer chosen without its blind spot stated is a
layer someone will later trust for the wrong thing.

| Layer | Catches | Cannot catch |
| --- | --- | --- |
| **Offline unit and contract tests** — no gate, no fixtures, `pd`'s own logic in isolation | flag parsing, the ADR-0016 selector grammar, ADR-0001 error mapping and exit codes, ADR-0003 bounding arithmetic, the trailer counters, ADR-0017 §9 dedup keys, ADR-0018 chunking | anything about a response body; a wrong `next_cursor`; that the operation `pd` calls exists |
| **Fixture replay at the gate** (§2) — recorded responses served from disk | the whole walk: pagination, validation and rejection, resolution, projection, search normalisation, the streaming and trailer contract, timing behaviour under a fake clock | Pipedrive changing. A fixture is a photograph — it stays true to the day it was taken and never notices anything after it |
| **Live suite** (§9) — explicitly invoked, read-only, human-read | Pipedrive changing: a widened search projection, a renamed field, a new enum, an operation that moved | nothing on a schedule, because nothing runs it on a schedule; and never a retry or 429 path, permanently (§9) |

Beside all three sit the **CI gates** (§8). Those are not tests in the regression sense. They assert
safety properties, they fail hard rather than report, and no coverage argument can retire one.

### 2. The seam is `guardedFetch`, and it is the only seam

Locked point 7 puts every HTTP call through one client module, and
[ADR-0007](0007-the-narrow-v1-users-client.md) put **two** generated clients behind it. A replay layer
installed at a client would let the v1 `GET /users` traffic escape it, so replay is installed where the
traffic converges: the custom `fetch` that research 06 §1.5 made the choke point, the same function
ADR-0013 §1 hangs the non-GET refusal on.

This has a consequence worth stating, because it is the reason the seam is worth more than its
convenience: **replay sits below the guard, not around it.** A test cannot accidentally test its way
past the read-only property, because the property is enforced on the near side of the swap. Every
fixture-replay test in the suite is also, silently, another execution of ADR-0013's refusal path.

It also gives every ADR that asked for an *"and no request was made"* assertion the same answer.
ADR-0016 §6's offline exit 2, ADR-0017's three refusals, ADR-0018's three request-count tests — all of
them are one question put to one object: how many dispatches did the gate record?

### 3. Replay is strict, and zero requests is mechanical

The replay gate has no passthrough. A request with no matching fixture is a **test failure**, never a
network call. The network path is not merely unused under `bun test`; it is unreachable — the gate is
constructed with a transport that throws.

So "zero requests on every `bun test` run" is not a discipline anyone has to remember. Forgetting to
record a fixture fails the test that needed it, in the same run, on the developer's own machine. The
failure mode of the naive approach — a test suite that quietly starts making live calls because
someone added a case — cannot occur.

Fixtures are keyed by method, path and the sorted query parameters that `pd` actually varies. Two
requests differing only in a parameter `pd` never sends collapse to one fixture; two differing in
`cursor` or `ids` do not.

### 4. One injected clock, and it is not complexity bought for tests

ADR-0011 made three separate things timing behaviour: the 10-requests-per-2-seconds gate, the
three-strike 429 pause at ≤2 s each, and the 250 ms / 1 s / 4 s jittered 5xx backoff. ADR-0015 §4
added a fourth, the ~1 Hz status line. ADR-0005 added a fifth in a different register — the 24 h and
1 h cache TTLs — and ADR-0010 a sixth, the 15-minute `blocked` sentinel.

Tested against the real clock, the retry-budget test alone costs about six seconds, the 5xx test
another five, and the TTL tests are not testable at all within a human lifetime of patience.

So a single `Clock` — `now()` and `sleep()` — is injected into the same module that already takes the
injected `fetch`. The ticket asked whether that is a testing seam or production complexity bought for
tests. It is neither: it is one more parameter on a module that already has one, at a boundary that
already exists for an unrelated reason. Nothing else in `pd` reads the wall clock, and no other module
gains a parameter.

The jitter in ADR-0011 §8's backoff is seeded from the same injected source, so a backoff test asserts
exact sleep durations rather than a range.

### 5. Test isolation reuses the paths ADR-0005 and ADR-0012 already defined

No `--state-dir`, no `PD_TEST_HOME`, no test-only flag or environment variable of any kind. ADR-0014
§6's table already makes every on-disk location relocatable: `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` on
POSIX, `%LOCALAPPDATA%` and `%APPDATA%` on Windows. A test points them at a temporary directory it
owns and deletes.

That answers the ticket's question about ADR-0010's `blocked` sentinel directly. The sentinel is
unreachable from `--no-cache` and from `pd cache clear` *by design* — but that design was about
refusing an agent a flag, not about hiding a file. A test places the sentinel by writing it and clears
it by deleting it, which is exactly what the 15-minute expiry does from the other end. No production
surface is added to make the sentinel testable, because none is needed.

The same mechanism covers the credential: a test writes a `0600` file in the temp config directory, or
sets `PD_API_TOKEN`, and gets the ADR-0012 §3 chain it wants without a fixture of its own.

### 6. The replay store is not the cache, and sharing them would be a false economy

The ticket asked whether the replay layer reuses ADR-0005's keyed, version-stamped on-disk store. It
does not, and the reason is that the two stores are allowed to fail in opposite directions.

The cache is **deliberately partial and deliberately stale**: five near-static resources and no records
at all, TTLs of 24 h and 1 h, a version stamp that invalidates a whole generation, keyed by credential
hash. Every one of those properties is wrong for a fixture store, which must hold record responses,
must never expire, must not care which credential recorded it, and must be keyed by request rather
than by resource.

Sharing them would couple a store that is *permitted* to be stale to a store whose staleness is the
one thing the design is trying to make visible. They stay separate: fixtures live in the repository
under version control; the cache lives in the user's cache directory and is never committed.

The cache is still exercised, of course — a fixture-replay test with a temp cache directory (§5) is how
ADR-0005's TTL, one-shot refresh and `--max-requests` accounting are tested at all, with §4's clock
moving time.

### 7. Tests run under Bun; the shipped bundle is smoke-tested under Node

*Amended by [ADR-0021](0021-distribution-build-from-source.md) §8. The shipped artifact is a compiled
Bun binary, not a Node-targeting bundle, so the two Node smoke legs are removed and replaced by a
**binary smoke leg** on Linux and Windows: build `dist/pd`, then run the same fixed set of end-to-end
invocations against the binary. This section's argument is unchanged — assertions about the artifact
cannot be made about the source — only its referent is. Of the three artifact-only assertions below,
the version agreement survives with `pd --version` now carrying ADR-0021 §6's commit suffix; the
`unsupported_runtime` refusal is **deleted** with the variant; and "no fixture in the tarball" becomes
**no fixture embedded in the binary**. One assertion is added: a `.env` in the process CWD does not
reach `pd auth status` as the `env` tier (ADR-0021 §3).*

ADR-0014 §3 handed this ticket the question and it is answered in two parts, because the risk is in two
places.

**The suite runs under Bun.** It is the development runtime, it is fast, and the ESLint ban on the
`Bun` global and `bun:*` imports in `src/**` is what keeps the code under test runtime-neutral. Running
the full suite twice would double CI time to re-prove what the lint gate already proves statically.

**A separate leg runs the built bundle under Node.** Build the artifact ADR-0014 §2 ships, then execute
a fixed set of end-to-end invocations against it under Node 20 and the current LTS. This leg is short —
it is a smoke test, not a second suite — and it exists because the lint gate proves the *source* uses no
Bun API while the users run the *bundle* under Node, and a bundler is perfectly capable of introducing
the gap the lint rule was banning.

Three things are asserted on the built bundle specifically, because none of them exists in source form:

- ADR-0014 §5's version agreement — `pd --version` and the manifest's `pd_version` report the same
  string, which is only true after the build stamps it.
- ADR-0014 §9's `unsupported_runtime` refusal, exercised by invoking the bundle under a runtime below
  the floor.
- ADR-0014 §1's package contents (§10) — that the tarball contains the bundle and no fixture.

The Windows runner ADR-0014 §6 committed CI to runs this same bundle smoke leg, and its whole purpose
is the `%LOCALAPPDATA%` / `%APPDATA%` resolution that is the only Windows-specific code in `pd`.

### 8. The mandatory set: tests that exist because a property requires them

These are not chosen. Each one is the enforcement mechanism of a decision made elsewhere, and the
sessions that made those decisions were explicit that this ticket may decide the shape but not the
existence.

| Source | Assertion | Where |
| --- | --- | --- |
| ADR-0013 §2 | Both generated clients contain zero non-GET operations after regeneration | CI gate |
| ADR-0013 §2 | ESLint `no-restricted-imports` on `**/generated/**` | CI gate |
| ADR-0013 §1, §4 | A non-GET driven through the single client yields `write_blocked`, exit 1, and dispatches nothing | Unit |
| ~~ADR-0014 §3~~ | ~~ESLint ban on the `Bun` global and every `bun:*` import in `src/**`~~ — removed by [ADR-0021](0021-distribution-build-from-source.md) §2 | — |
| ADR-0021 §3 | The built binary ignores a `.env` in the process CWD: `pd auth status` run beside one setting `PD_API_TOKEN` does not report the `env` tier | CI gate, on the binary |
| ADR-0015 §6 | No unredacted query value and no non-allowlisted header can reach stderr | CI gate |
| §10 below | No credential-shaped string exists anywhere in the fixture tree | CI gate |
| §10 below | The published artifact contains no fixture — per [ADR-0021](0021-distribution-build-from-source.md) §8 this is checked against the built binary, not an `npm pack` output | CI gate |
| ADR-0015 §1 | A non-TTY run emits exactly two things on stderr, and neither is progress | Replay |
| ADR-0016 §7 | The same projection with and without the `custom_fields` push-down is **byte-identical** | Replay, fixture pair |
| ADR-0016 §6 | An unknown top-level selector exits 2 with zero dispatches | Offline |
| ADR-0017 §7 | Minimum-term refusal, `--filter-id` with `--ids` refusal, `--sort-by` on search — each exit 2, zero dispatches | Offline |
| ADR-0017 §9 | The `(record_type, id)` dedup key on a mixed `pd items search` fixture | Replay |
| ADR-0018 | 250 ids issue exactly three requests; duplicate ids issue the same requests as without them; two omitted ids produce one `unmatched_ids` warning and exit 0 | Replay |

The six CI gates are the load-bearing half. Four of them assert a *safety* property — no writes exist,
no write can be issued, no credential leaks to stderr, no credential leaks to the repository — and a
safety gate that merely warns is not a gate. All six fail the build.

ADR-0015 §1's stderr test needs the run to lie about whether stderr is a TTY. That is one injected
predicate on the diagnostics module, on exactly the reasoning §4 used for the clock.

The projection byte-identity test deserves its billing as the highest-value single test in the map: it
is the only thing standing between an upstream optimisation and a silent contract change, and because
the two runs differ only in what was requested, it needs a fixture *pair* recorded from the same
account state — which is a recording-time constraint, not a test-time one.

### 9. The live suite exists, is invoked by hand, and never provokes a failure

A separate suite, a separate command, and three hard rules.

- **It never runs in CI, and never on a schedule.** A weekly automated run was rejected: it would put a
  silent recurring cost on the shared budget with nobody reading the result, which is the worst of
  both designs.
- **It never runs as part of `bun test`.** §3 makes that mechanical rather than conventional — the
  default gate has no network transport at all, so the live suite is the only thing that constructs
  one.
- **It is read-only by construction**, because it routes through the same guarded client as production
  and inherits all four of ADR-0013's layers. It carries a hard `--max-requests` ceiling, and it is
  the only place in the project that supplies one by default.

**It runs against the real company account.** No sandbox tenant is required. That was a deliberate
choice: a sandbox would have its own custom-field schema, its own option ids and its own emptiness, so
a fixture recorded there would pin a shape that no user of `pd` will ever meet — which is precisely the
value the live suite exists to provide.

**It never tests a retry path, a 429, or the Cloudflare block. Permanently.** Research 01's asymmetry
makes that test the one whose *successful execution* costs the company its API access. Those paths are
tested against fixtures with §4's clock, where a 429 is a recorded response and a two-second pause is a
number, and they are tested nowhere else. This is not a gap to close later; it is a refusal, and it is
the strongest single reason the fake clock is worth its parameter.

**Its output is a re-recording, not a pass or fail.** The live suite fetches, writes fixtures, and
leaves a git diff for a human to read. It does not assert equality against the committed fixtures and
fail the run — that design produces a suite that goes red every time a colleague edits a deal, and a
suite that is red for uninteresting reasons is a suite nobody reads. A diff touching only values is
noise; a diff touching keys is Pipedrive changing under `pd`, and that is the signal the whole layer
exists to produce.

This is the honest answer to ADR-0017's fixture problem, and it should be read as a limitation rather
than a solution: the four search-hit schemas have no live record to diff against, so if Pipedrive
widens the hit projection, nothing detects it until somebody runs the live suite and reads the diff.
Accepted. The alternative — never re-recording — makes the same failure permanent instead of merely
manual.

### 10. Fixtures keep real CRM data, and that has named consequences

*Confirmed and extended by [ADR-0021](0021-distribution-build-from-source.md) §9. The repository stays
private, and under ADR-0021 it is also the distribution channel — so this section now bounds who can
obtain `pd` at all, not only who can read the fixtures. Splitting the fixtures into a second repository
and sanitising them for a public one were both considered there and declined. Read "the tarball" below
as "the built binary": the gate is the same, checked against `dist/pd`. The reference to ADR-0014 §1's
public npm package is stale — there is no published package.*

Recorded responses are committed verbatim: real deals, real organisation names, real contact addresses,
real amounts, real owners. Anonymisation at record time was rejected in favour of the fixture being
exactly what Pipedrive returned.

Two things follow, and both are written here rather than assumed:

**The repository being private is now a load-bearing property of this design, not a circumstance.**
`pd` ships as a public npm package under ADR-0014 §1, and a reader may reasonably assume the source is
public too. It is not, and it cannot become public by flipping a setting: fixtures persist in git
history, so opening the repository would be a history-rewrite exercise, planned as such. Anyone
proposing it should read this section first.

**No fixture ships to npm.** The package manifest carries an explicit `files` allowlist rather than an
ignore list, so a new directory is excluded by default instead of included by default, and a CI gate
asserts the packed tarball's contents. This is the difference between the repository (private, holds
real data) and the artifact (public, holds a bundle) being enforced rather than intended.

**The credential is stripped mechanically, and it is not CRM data.** The recorder never writes request
headers at all, which disposes of the `x-api-token` header ADR-0012 §1 fixed as the transport. Research
05's `grep -c api_token` returning zero in both OpenAPI specs means there is no query-parameter path to
strip either, but the gate does not rely on that staying true: a CI check greps the whole fixture tree
for credential-shaped strings and fails the build on a hit. The user's decision was about *CRM* data;
it was never about the token, and the token has no exception.

## Consequences

- **`bun test` costs zero Pipedrive requests, mechanically.** Not by convention, not by a reviewer
  noticing: the default gate has no transport, so a missing fixture fails a test instead of spending a
  request.
- **The CI gate count goes from four to six**, and four of the six now assert safety properties rather
  than behaviour. Three ADRs in a row produced one — ADR-0013 two, ADR-0014 §3 a third, ADR-0015 §6 a
  fourth — and this one adds the fixture-tree and tarball-contents checks.
- **`guardedFetch` gains two injected dependencies, a transport and a clock**, and one diagnostics
  module gains an injected TTY predicate. That is the entire production cost of the strategy. No flag,
  no environment variable, no manifest entry, no error variant, and `manifest_version` does not move.
- **No test-only surface exists at all.** Isolation runs on the `XDG_*` and Windows paths ADR-0005,
  ADR-0012 and ADR-0014 already defined, which is why the `blocked` sentinel can be driven by a test
  without becoming settable by an agent.
- **Two known blind spots, both stated rather than closed.** Pipedrive can change without anything
  noticing until a human runs the live suite; and the retry, 429 and Cloudflare paths are never
  exercised against the real API, on purpose and permanently.
- **The repository must stay private.** Recorded fixtures hold real customer data and git history keeps
  it. This is now a design constraint with a name, and `AGENTS.md` says nothing about it — it is a
  contributor fact, not an agent-visible one.
- **CI runs four legs**: the Bun suite plus lint and the gates, the Node 20 and Node LTS bundle smoke,
  and the Windows bundle smoke. The three bundle legs exist to protect ADR-0014's single distribution
  channel, and they are short by design.
- **Nothing in the agent-visible contract changed.** This ADR adds no line type, no flag, no exit code
  and no warning kind — it is the first in the map whose net surface addition is zero.
