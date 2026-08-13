# ADR-0021: `pd` is built from source, and the repository is the channel

Status: accepted
Date: 2026-08-13
Deciding input: user direction — "jakelu täytyy suunnitella uudestaan … täytyy ladata repo ja bun js:llä tehdä binaari"
Supersedes: [ADR-0014](0014-distribution.md) in full
Withdraws: [ADR-0001](0001-error-model-and-exit-codes.md)'s thirteenth variant `unsupported_runtime`, which ADR-0014 §9 added
Releases: [ADR-0012](0012-authentication-and-credential-resolution.md) §4's constraint — the `Bun.*` ban is no longer load-bearing
Reinforces: [ADR-0005](0005-cache-design.md) §6 — the original "the binary may sit on a read-only path" reason returns
Amends: [ADR-0019](0019-testing-strategy.md) §7 and §8 — the Node smoke legs and the `Bun.*` lint gate are replaced
Amends: [ADR-0019](0019-testing-strategy.md) §10 — the fixtures leave this repository so it can be public (§9)

## Context

[ADR-0014](0014-distribution.md) chose a public npm package on one premise, stated in its own words:
"the consumer is an agent harness, and agent harnesses carry Node." Everything else in it — the
bundled `.js`, the `#!/usr/bin/env node` shebang, the ES2020 prelude, the `unsupported_runtime`
variant, the ban on `Bun.*` in `src/**`, the npm scope forced by three taken package names — followed
from that premise rather than standing on its own.

**The premise is withdrawn.** `pd` is not published to a registry. A user who wants `pd` clones this
repository and builds the binary with Bun on their own machine. That changes what the consumer is
assumed to carry: not Node, but Bun and a checkout — which is what a developer working on `pd`
already has, and what an agent harness that can run `git clone` can get.

Two measured facts from
[research 07](../../.scratch/pd-cli-design/research/07-bun-distribution.md) decide the shape of the
new channel, and one of them is what makes the channel viable at all.

**Gatekeeper is not in the path of a locally built binary.** Research 07 §1.5 measured the whole
matrix: a fresh `--compile` output is ad-hoc signed, fails `codesign -v` because Bun appends its
payload after the Mach-O signature, and is killed outright — exit 137, SIGKILL, no output — when it
carries a `com.apple.quarantine` xattr. Ad-hoc re-signing does **not** rescue a quarantined binary.
But quarantine is set by the *downloader*, not by the file: `curl` sets none, and a binary the user
compiled on their own disk has none either. This is exactly why ADR-0014 rejected the
browser-download path while research 07 called notarization "not needed" for every other path.
Building locally lands on the safe side of that line, so **no Developer ID certificate and no
notarization step exist in this design.**

**The `.env` footgun that ADR-0014 declared dead is alive again.** Research 07 §1.4 measured it: a
compiled executable auto-loads `.env` and `bunfig.toml` from the process CWD by default. A binary
printing `process.env.PD_SECRET` printed `leaked` with a `.env` in the CWD. `pd` resolves its
credential from `PD_API_TOKEN` at tier 2 ([ADR-0012](0012-authentication-and-credential-resolution.md) §3),
and its consumer is an agent that `cd`s into arbitrary repositories. Under a naive build, standing in
a repository whose `.env` sets `PD_API_TOKEN` silently runs `pd` against a different Pipedrive
account. ADR-0014 §Consequences wrote "the footgun dies with the binary"; it is now this ADR's §3 to
kill deliberately.

## Decision

### 1. One channel: clone the repository, run one build command

```
git clone <repo> && cd pipedrive-cli
bun install
bun run build          # → dist/pd
```

No npm package. No registry of any kind. No GitHub Release artifact, no `curl | sh` installer, no
Homebrew tap, no per-platform CI build matrix, no code signing, no notarization. The entire second
half of research 07 stays declined, and the first half — `bun build --compile` — is now the whole
story.

The npm names ADR-0014 §1 shopped for (`pd`, `pipedrive-cli`, `pd-cli`, `@zimple/pd`) are irrelevant
and the scope is dropped. The **command** name stays `pd`, as every ADR in this map assumes. The PATH
collision ADR-0014 accepted with `pd-cli`'s own `pd` bin no longer exists unless the user creates it,
because nothing installs a `pd` on their behalf.

**The repository is public and there is no access control**, which §9 pays for by moving the fixture
tree out of it. Nothing secret ships — ADR-0012 keeps every credential out of the tree, and
[ADR-0013](0013-read-only-enforcement.md) keeps every write out of the code — so the clone is
uninteresting to anyone without a Pipedrive token of their own.

### 2. Bun is the only runtime, at build time and at run time

The compiled binary embeds Bun's runtime — ~60.5 MiB of it, per research 07 §1.2, with `pd`'s whole
dependency graph adding ~0.3 MiB on top. The host needs nothing installed to run it.

This inverts ADR-0014 §3 rather than amending it. There is no Node target, no `#!/usr/bin/env node`
shebang, no bundled `.js` artifact and no ES2020 syntax floor. **`Bun.*` and `bun:*` are permitted in
`src/**`**, and the ESLint rule plus CI gate that banned them are removed.

Two things that freedom does *not* do, said out loud so a later ticket does not assume otherwise:

- **[ADR-0012](0012-authentication-and-credential-resolution.md) §4's keychain refusal stands.**
  `Bun.secrets` is reachable again, but §4's decision rested on ADR-0012 §5 — `pd` has no `login`
  command, so nothing ever puts a credential *into* a store, which leaves the tier unreachable
  whatever the API surface allows. The distribution argument was a second reason, not the reason.
- **`bun:sqlite` does not become the cache.** [ADR-0005](0005-cache-design.md) §6's plain `0600` files
  written through a temporary file and `rename` are unchanged. Research 07 §3 records the specific
  hazard: a `bun:sqlite` database resolved by relative path resolves against the **process CWD**, not
  the executable's location, which is a bug generator for a tool an agent runs from arbitrary
  directories.

Bun's own version floor is a **build-time** concern. `package.json` declares `engines.bun`, and the
build script fails with a plain message when `Bun.version` is below it. A person building from source
reads build output; this is not a runtime condition and gets no error variant — see §7.

### 3. The build command is normative, and two of its flags are a safety property

```
bun build --compile --minify --bytecode \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --define PD_VERSION='"<stamped>"' \
  src/cli.ts --outfile dist/pd
```

`bun run build` wraps exactly this, and **no supported way to build `pd` omits the two autoload
flags.** They are not an optimisation. Without them, a repository-local `.env` on the agent's current
path overrides the credential chain of ADR-0012 §3 from outside the chain, which is a silent
account switch rather than an error. The Bun documentation notes these autoloads "may also be
disabled by default" in a future version, so pinning the flags also protects against that change
arriving from underneath.

Equivalently, in a `Bun.build()` script: `compile: { autoloadDotenv: false, autoloadBunfig: false }`.

`--minify --bytecode` is kept on measurement, not taste: research 07 §1.3 measured 21.5 ms startup
with it against 27.1 ms without, for +2.9 MB on a ~63 MB binary. Bun documents `--bytecode` as moving
JavaScriptCore parsing to build time, and it does not obscure source.

**A CI gate asserts the built binary ignores a CWD `.env`.** The check is research 07 §1.4's own
experiment, kept as a test: build, place a `.env` setting `PD_API_TOKEN` in a temporary directory, run
`pd auth status` from there, and assert it does not report the `env` tier. This joins the gate table
of [ADR-0019](0019-testing-strategy.md) §8, replacing the `Bun.*` ban this ADR removed.

### 4. `dist/pd` is the output, and `pd` installs nothing

`bun run build` writes `dist/pd` (`dist\pd.exe` on Windows) inside the checkout and stops there.

**There is no install script.** No `bun run install-local`, no `$PD_INSTALL_DIR`, no copy step the
project performs on the user's behalf. Getting the binary onto `PATH` is the user's business, and the
project has no opinion worth encoding about where their `PATH` directories are.

This is the smallest surface that works, and it keeps a property the rest of the design cares about:
a tool whose safety claim is "it cannot write anything" ships no code that writes outside its own
checkout. `AGENTS.md` shows `cp dist/pd ~/.local/bin/` as an example and says explicitly that the
destination is the reader's choice.

On macOS the binary runs as built. `codesign -v` reports `invalid signature` on fresh `--compile`
output (research 07 §1.5) because Bun appends its payload after the signature; `codesign --force -s -
dist/pd` repairs the seal if some other tool demands a valid one. Neither step is required to run
`pd`, and `bun run build` does not perform them.

### 5. Everything the binary needs is embedded at build time

A compiled binary has no sibling files. `AGENTS.md` is therefore **embedded into the binary at build
time** and `pd docs` writes the embedded copy to stdout. It is never read from disk, never resolved
relative to the executable, and never relative to the CWD.

This preserves ADR-0014 §7's actual guarantee — that `pd docs` matches the binary that emits it — by
a mechanism that survives the binary being copied anywhere. Research 07 §3 records that embedded
asset paths inside a compiled binary are read-only virtual paths under `/$bunfs/root/`, which is
exactly the property wanted: readable, never writable, never missing.

`pd docs` remains a grammar exception and an NDJSON-stdout exception, on ADR-0014 §7's reasoning,
unchanged.

### 6. `pd --version` reports the commit it was built from, not just a tag

There is no registry to inherit a version from, and every binary is built from whatever commit its
builder happened to have checked out. A bare semver string would therefore be a claim the artifact
cannot support: two binaries printing `1.0.0` may be a hundred commits apart.

The version is stamped at build time through `--define`, from three sources:

| built from | `pd --version` prints |
| --- | --- |
| a clean checkout at a release tag | `1.0.0` |
| a clean checkout not at a tag | `1.0.0+g3f9a1c2` |
| a checkout with uncommitted changes | `1.0.0+g3f9a1c2.dirty` |

The base is `package.json`'s `version`; the suffix is semver build metadata, which semver defines as
ignored in precedence comparison, so the contract below is unaffected by its presence.

ADR-0014 §5's semver contract survives verbatim and is restated because it is the part an agent
depends on:

| bump | means |
| --- | --- |
| MAJOR | an NDJSON line shape, a `type` tag, a trailer field, an exit code, an ADR-0001 error `code` string, or a command changes or disappears |
| MINOR | a new command, a new flag, or a new field on an existing line — additive only |
| PATCH | a fix with no contract change |

`manifest_version` still moves in lockstep with MAJOR. The manifest still carries `pd_version` beside
it, now carrying the same suffixed string, so an agent reporting a bug names an exact commit. First
release from this spec is `1.0.0`.

`pd --version` still prints that one string and nothing else — plain text on stdout, still an
exception to ADR-0002 beside `--help`, `pd manifest` and `pd docs`.

### 7. `pd` never checks for a newer version of itself, and there is no `unsupported_runtime`

ADR-0014 §4's refusal is kept and is now easier: there is no registry to poll even if the design
wanted to. A registry check would be an HTTP request that is not a Pipedrive GET, which either
violates [ADR-0011](0011-concurrency-and-retry.md)'s premise that everything in the gate is rate-
accounted Pipedrive traffic, or bypasses the single client ADR-0013 spent four layers protecting.
Updating is `git pull && bun run build`, owned by whoever owns the checkout.

**`unsupported_runtime` is withdrawn.** ADR-0014 §9 added it as ADR-0001's thirteenth variant because
a Node-targeting bundle could be launched by a Node too old to parse it. The compiled binary carries
its own runtime, so the condition cannot arise: there is no host runtime to be wrong. ADR-0001
returns to **twelve** variants, `write_blocked` ([ADR-0013](0013-read-only-enforcement.md) §4) being
the last. Nothing has shipped, so no compatibility argument applies, and ADR-0001's own rule that
adding a variant is non-breaking says nothing about this direction — the removal is free only because
no consumer exists yet, and that is stated rather than assumed.

The ES2020 syntax floor of ADR-0014 §9, which existed solely so the refusal could parse on the
runtime it refused, dies with the variant. It must not survive as a bundler setting nobody can
justify.

### 8. Windows is supported by the same source path, and the CI legs change shape

Both per-user directories keep ADR-0014 §6's mapping, unchanged:

| purpose | POSIX | Windows |
| --- | --- | --- |
| cache ([ADR-0005](0005-cache-design.md) §6) | `$XDG_CACHE_HOME/pd/<token-hash>/`, default `~/.cache/pd/` | `%LOCALAPPDATA%\pd\<token-hash>\` |
| config ([ADR-0012](0012-authentication-and-credential-resolution.md) §3) | `$XDG_CONFIG_HOME/pd/`, default `~/.config/pd/` | `%APPDATA%\pd\` |

A Windows user runs the same three lines and gets `dist\pd.exe`. The NTFS permission gap stands as
ADR-0014 §6 stated it: `0600` has no NTFS equivalent, `pd` only ever **reads** the credential file, and
`pd auth status` carries the platform caveat in the `warnings` array of ADR-0013 §4. No other command
carries it.

[ADR-0019](0019-testing-strategy.md) §7's leg structure is replaced:

| leg | was (ADR-0014) | is now |
| --- | --- | --- |
| suite + lint + gates | Bun | Bun, unchanged |
| bundle smoke under Node 20 | yes | **removed** |
| bundle smoke under current Node LTS | yes | **removed** |
| binary smoke | — | **build `dist/pd`, run the end-to-end invocations against the binary**, on Linux and Windows |
| Windows | bundle smoke | binary smoke, same purpose: `%LOCALAPPDATA%` / `%APPDATA%` resolution is the only Windows-specific code |

The binary leg keeps ADR-0019 §7's real argument — that assertions about the artifact cannot be made
about the source — and updates what the artifact is. Two of its three named assertions survive with
new referents: the embedded `AGENTS.md` of §5, and the version stamp of §6. The third, ADR-0014 §9's
`unsupported_runtime` refusal, is deleted with the variant. It gains the `.env` assertion of §3.

ADR-0019 §10's "no fixture in the tarball" gate becomes **no fixture in the binary**: the same
concern, checked against `dist/pd` instead of a `npm pack` output, since a fixture tree reachable
from the entrypoint would be embedded rather than published.

### 9. This repository becomes public, and the fixtures leave it

[ADR-0019](0019-testing-strategy.md) §10 made the repository's privacy a design constraint with a
name: fixtures are recorded verbatim from the real company account — real deals, real organisation
names, real amounts, real owners — and they persist in git history, so the repository "cannot become
public by flipping a setting."

Making the repository the distribution channel would otherwise fuse two audiences that ADR-0014 kept
apart: under npm a stranger could install `pd` without seeing a fixture, and under a clone-to-build
channel anyone who can obtain `pd` can read the company's CRM.

**The fixtures move out instead.** They live in a separate private repository, consumed by the test
suite as a submodule or a fetched path, and this repository — the one a user clones to build `pd` —
is public and carries none of them.

The reason this is cheap rather than a git-history excavation: **no fixture has been recorded yet.**
Nothing is implemented, the tree holds design documents and prototypes, and
[ticket 05](../../.scratch/pd-impl/issues/05-deals-list-the-full-walk.md) is where the first recording
would land. The constraint is being honoured *before* it binds, which is the only moment it is free.
Splitting after the first fixture lands means rewriting history, and ADR-0019 §10 already says that is
not a thing a setting can undo.

Three consequences follow and are accepted:

- **The replay suite is not runnable from a clean public clone.** An outside contributor gets the
  offline unit and contract tests of ADR-0019 §1 and the CI gates; the fixture-replay layer needs
  fixture-repository access. This is stated in the README rather than discovered.
- **CI needs a credential to reach the fixture repository**, and it is a repository read token — never
  a Pipedrive token. ADR-0019's whole point is that `bun test` costs zero Pipedrive requests, and that
  is unchanged: the gate is fixture replay with no passthrough.
- **The live suite of ADR-0019 §9 stays where the fixtures are.** It is the thing that records them,
  it runs against the real account, and it is invoked by hand. It has no business in a public tree.

`AGENTS.md` documents a public clone with no mention of fixtures; the fixture repository is a
contributor concern, not a user one.

## Consequences

- **[ADR-0014](0014-distribution.md) is superseded whole.** It keeps its `Status: accepted` history but
  gains a `Superseded by` header. Nothing in it is cited normatively any more; the parts that survive
  — the semver contract, the Windows path mapping, the no-self-update refusal, `pd docs` — are restated
  here so no reader has to diff two documents to know what holds.
- **[ADR-0001](0001-error-model-and-exit-codes.md) returns to twelve variants.** `unsupported_runtime`
  is removed from the `code` union and from the manifest's mapping table.
- **[ADR-0012](0012-authentication-and-credential-resolution.md) §4 is released, not reversed.** The
  `Bun.*`-free freedom it preserved is no longer needed, and no decision changes because of it. Any
  future ticket may now use a `Bun.*` API without reopening an ADR — but §2 above names the two
  specific temptations, `Bun.secrets` and `bun:sqlite`, that remain refused on their own grounds.
- **[ADR-0005](0005-cache-design.md) §6 gets its original reason back.** ADR-0014 noted that its "the
  binary may sit on a read-only path" argument no longer applied under npm. It applies again, and its
  decision — an absolute, CWD-independent user path, never a path beside the executable — is now
  load-bearing rather than merely still-correct. Research 07 §3 is explicit that a compiled binary has
  no writable location next to itself.
- **[ADR-0019](0019-testing-strategy.md) §7, §8 and §10 are amended.** The gate count is unchanged in
  spirit: one gate leaves (the `Bun.*` ban) and one arrives (the CWD `.env` assertion). §10's "the
  repository must stay private" is replaced by §9's split — the constraint is honoured by where the
  fixtures live rather than by where the code lives, and the credential-shaped-string gate follows the
  fixtures into their own repository.
- **The fixture split is work that must happen before ticket 05**, which is where the first recording
  would otherwise land in a tree that is about to become public. It is free today and expensive the
  day after.
- **The credential threat model gains one entry and loses none.** A CWD `.env` is a credential-
  substitution vector unique to the compiled artifact, closed by a build flag rather than by code,
  which means it is closed only as long as the documented build is the one that runs. That is why §3
  makes it a CI assertion on the binary rather than a note in a build script.
- **No release pipeline exists to maintain.** No five-target matrix, no Apple Developer account, no
  signing keys, no registry credential, no publish step, no `optionalDependencies` fan-out, and no
  supply-chain surface at all: nothing is fetched from a registry at install time because there is no
  install time.
- **The cost is paid at the consumer.** Every user needs Bun, a checkout, and a ~63 MB build output
  per machine, and updating is a `git pull` a harness owner must perform deliberately. `npx`-style
  zero-install invocation is gone with no equivalent. This is accepted: the consumer is a harness
  under someone's control, not an anonymous installer.
- **Startup improves.** 21.5 ms for the compiled binary against ADR-0014's 35.8 ms Node floor
  (research 07 §1.3). Invisible next to one Pipedrive round-trip either way, and not a reason for this
  decision.
- **`AGENTS.md` changes shape**: the install section becomes clone, `bun install`, `bun run build`,
  and "put `dist/pd` wherever your `PATH` is" — plus the Bun version floor, the two per-user directory
  locations per platform, and the sentence that `pd` never updates itself.
- **The design spec was rewritten against this ADR**: its §19, the solution paragraph, the error-union
  table, the runtimes-and-CI-legs section, the fixtures section, and the installation user stories —
  the npm-install story becomes clone-and-build, the Node-runtime-check story becomes the CWD `.env`
  refusal, and a story is added for `pd --version` naming its commit. Implementation tickets 01, 03,
  05, 19 and 20 were rewritten with it.
