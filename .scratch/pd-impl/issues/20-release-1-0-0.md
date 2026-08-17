# 20 — Release 1.0.0

**What to build:** A colleague clones this repository, runs `bun install && bun run build`, and gets a working `pd` on macOS, Linux and Windows. The binary contains no fixture and therefore no line of real CRM data. Three CI legs pass, five safety gates fail the build when violated, and the version the binary prints agrees with the version the manifest reports.

**Blocked by:** 09, 11, 12, 15, 18, 19

**Status:** done

Normative: [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) (distribution), ADR-0019 §10 (fixtures and gates), ADR-0013 (read-only gates).

*Rewritten 2026-08-13: ADR-0021 supersedes ADR-0014. No npm publish, no `files` allowlist, no tarball, no Node smoke legs, no `unsupported_runtime`, no `Bun.*` lint ban.*

## The five CI gates, all hard-failing

| Source | Assertion |
| --- | --- |
| ADR-0013 §2 | Both generated clients contain zero non-GET operations after regeneration |
| ADR-0013 §2 | ESLint `no-restricted-imports` on `**/generated/**` outside the client module |
| ADR-0015 §6 | No unredacted query value and no non-allowlisted header can reach stderr |
| ADR-0019 §10 | No credential-shaped string anywhere in the fixture tree |
| ADR-0021 §3 | The built binary ignores a `.env` in the process CWD — `pd auth status` beside one setting `PD_API_TOKEN` does not report the `env` tier |

All five assert a **safety** property: no writes exist, no write can be issued, no credential leaks to stderr, no credential leaks into the fixture tree, no foreign credential leaks *in*. **A safety gate that merely warns is not a gate.**

The sixth gate of the old ticket — "the published tarball contains no fixture" — becomes **no fixture is embedded in `dist/pd`**, checked against the binary. The seventh, the `Bun.*` ban, is deleted with the Node target.

Notes for the implementer:

- One channel: this repository. `git clone` → `bun install` → `bun run build` → `dist/pd`. No registry, no release artifact, no installer, no signing, no notarization. Notarization is not needed because a locally built binary carries no `com.apple.quarantine` xattr.
- **The repository stays private, and under ADR-0021 §9 that also bounds who can have `pd`**: its users are whoever has a clone. They already hold a write-capable Pipedrive token, so the fixture tree shows them nothing they cannot read live. Splitting the fixtures into a second repository and sanitising them for a public one were both considered in ADR-0021 §9 and declined; `.gitignore` is not an option, because ADR-0019 §9's signal is a git diff and an ignored directory has none.
- **Fixtures hold real CRM data** — real deals, real organisation names, real amounts, real owners, committed verbatim, and versioned. The credential is stripped mechanically and separately: the recorder never writes request headers at all.
- **`pd` never checks for a newer version of itself.** There is no registry to poll. Updating is `git pull && bun run build`.
- Three things are asserted **only against the built binary**: version agreement between `pd --version` and the manifest's `pd_version`, the embedded `AGENTS.md` behind `pd docs`, and that no fixture is embedded. The `.env` gate rides the same leg.
- CI runs three legs: the Bun suite plus lint and the gates; binary smoke on Linux; binary smoke on Windows. **Windows is a real leg** because path resolution is the only Windows-specific code and is exactly what an untested platform gets wrong.
- First release from the spec is **`1.0.0`**, tagged in git, with `manifest_version` in lockstep. A clean checkout at that tag builds a binary printing `1.0.0` with no suffix — that is what makes the tag meaningful.

## The live suite

A separate suite and a separate command. **Never in CI, never on a schedule, never part of `bun test`.**

- It runs against the **real company account** — a sandbox would pin a schema no user of `pd` will ever meet — read-only by construction through the same guarded client.
- It is the **only** place in the project that supplies a `--max-requests` ceiling by default.
- **Its output is a re-recording and a git diff, not a pass or fail.** A diff touching only values is noise; a diff touching keys is Pipedrive changing under `pd`, and that is the signal.
- **It never tests a retry path, a 429, or the Cloudflare block. Permanently.** Those are the tests whose *successful execution* costs the company its API access. They are tested against fixtures with the injected clock and nowhere else.

- [x] The repository is private, and `AGENTS.md` says the clone is of a private repository
- [x] A CI gate greps the whole fixture tree for credential-shaped strings and fails the build on a hit
- [x] A CI gate asserts no fixture is embedded in `dist/pd`
- [x] All five safety gates fail the build rather than warn
- [x] Three CI legs pass: Bun suite plus lint and gates, binary smoke on Linux, binary smoke on Windows
- [x] The built binary asserts version agreement, the embedded `AGENTS.md`, no embedded fixture, and the CWD `.env` refusal
- [x] `pd` makes no HTTP request that is not a Pipedrive GET, at any point in its lifecycle
- [x] The hand-invoked live suite exists, produces a re-recording plus a diff rather than a pass or fail, and is absent from CI and from `bun test`
- [x] The live suite contains no retry, 429 or Cloudflare-block test
- [x] `1.0.0` is tagged, and a clean checkout at the tag builds a binary printing `1.0.0` with no suffix
- [x] A clone-and-build from scratch yields a working `pd` on macOS, Linux and Windows
- [x] Design ticket 22 in `.scratch/pd-cli-design/issues/` is resolved once this and ticket 19 are done

## Comments

**2026-08-14 — implementation.** Added the hard-failing fixture credential and binary-exclusion
checks, consolidated all artifact-only assertions into one cross-platform gate, and wired that gate
to the Linux and Windows binary legs. The hand-invoked live recorder uses the production guarded
transport, writes no request headers, enforces one 30-request ceiling across its command set, stops
before retry-provoking responses, rewrites the versioned live fixture document and prints its git
diff. The offline suite, lint, typecheck, gate command, compiled-binary gate and clean-checkout build
all pass. Release tag: `v1.0.0`.

**2026-08-17 — verification.** Ran the whole acceptance list against the working tree: `bun run
lint`, `bun run typecheck`, `bun test` (557 pass, 0 fail), `bun run gates` (fixture credential
tree), `bun run build` and `bun run gates dist/pd` (version agreement, embedded `AGENTS.md`, no
embedded fixture, CWD `.env` refusal, platform credential path) all pass. `AGENTS.md` names the
clone as a private repository. The live recorder is invoked only by `bun run live` and appears in no
CI leg. Linux and Windows binary smoke are asserted by the two CI legs, not locally. Design ticket
22 is already resolved. Checklist ticked.
