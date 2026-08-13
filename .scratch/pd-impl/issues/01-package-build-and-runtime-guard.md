# 01 — Package, build and the compiled binary

**What to build:** A user clones this repository, runs `bun install` and `bun run build`, and gets `dist/pd` — a standalone compiled binary that prints its version and needs nothing installed on the host. The same build ignores a `.env` sitting in the directory `pd` is invoked from.

This is the skeleton every later ticket lands in: the package identity, the compile step, the safety flags on it, and the CI legs.

**Blocked by:** None — can start immediately.

**Status:** done

Normative: [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) (distribution), ADR-0019 §runtimes (CI legs).

*Rewritten 2026-08-13: ADR-0021 supersedes ADR-0014. There is no npm package, no Node target, no `#!/usr/bin/env node` bundle, no ES2020 prelude, no `unsupported_runtime` variant and no `Bun.*` lint ban. If you are reading a cached version of this ticket that mentions any of them, it is stale.*

Notes for the implementer:

- **Bun is the only runtime**, at build time and at run time. The binary embeds it. `Bun.*` and `bun:*` are permitted in `src/**`.
- The build command is normative:

  ```
  bun build --compile --minify --bytecode \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --define PD_VERSION='"<stamped>"' \
    src/cli.ts --outfile dist/pd
  ```

  `bun run build` wraps exactly this. Equivalently in a `Bun.build()` script: `compile: { autoloadDotenv: false, autoloadBunfig: false }`.
- **The two autoload flags are a safety property, not an optimisation.** A compiled binary auto-loads `.env` and `bunfig.toml` from the process CWD by default. `pd`'s consumer is an agent that `cd`s into arbitrary repositories, and `PD_API_TOKEN` is tier 2 of the credential chain — so without the flags, standing in a repository with a `.env` silently runs against a different Pipedrive account. Bun's docs note the autoloads may become opt-in later, so pinning the flags also protects against that change.
- `--minify --bytecode` is kept on measurement: 21.5 ms startup against 27.1 ms, for +2.9 MB on a ~63 MB binary.
- **No install script.** `bun run build` writes into the checkout and stops. Putting `dist/pd` on `PATH` is the user's business.
- `pd --version` prints the stamped version and nothing else: `1.0.0` from a clean checkout at a tag, `1.0.0+g<sha>` off a tag, `1.0.0+g<sha>.dirty` with local changes. The base comes from `package.json`; the suffix is semver build metadata.
- Bun's own version floor is a **build-time** concern: `engines.bun` in `package.json`, plus a build script that fails with a plain message below it. It is not a runtime error variant.
- On macOS the binary runs as built; `codesign -v` failing on fresh `--compile` output is expected and not fixed by the build.

- [x] `package.json` has no `bin`, no npm scope and no `dependencies` intended for a consumer; `engines.bun` declares the build floor
- [x] `bun run build` produces `dist/pd`, executable, running with nothing installed on the host
- [x] The build passes `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`, and no documented build path omits them
- [x] A `.env` setting `PD_API_TOKEN` in the process CWD does not reach the credential chain — asserted against the built binary, as a CI gate
- [x] `pd --version` prints the bare stamped string and exits 0, with the `+g<sha>` and `.dirty` suffixes behaving as specified
- [x] The build fails with a readable message when `Bun.version` is below `engines.bun`
- [x] CI runs three legs: Bun suite + lint + gates, binary smoke on Linux, binary smoke on Windows
- [x] `bun test` runs and passes with the initial suite
- [x] `dist/` is in `.gitignore`

## Comments

**2026-08-13 — implemented.**

- `scripts/build.ts` is the single build path, exporting `buildBinary` with
  `compile: { autoloadDotenv: false, autoloadBunfig: false }` — ADR-0021 §3's documented
  equivalent of the two normative flags. `bun run build` and the gate test both call it, so no
  build path can omit them.
- `src/version.ts` holds `stampVersion`, the pure seam under the three version shapes; the git
  plumbing (`rev-parse --short`, `tag --points-at`, `status --porcelain`) stays thin around it. A
  release tag is `v<version>`.
- The CWD `.env` gate (`test/dotenv-autoload.test.ts`) compiles a probe entrypoint through
  `buildBinary` and asserts it prints `unset` beside a `.env` setting `PD_API_TOKEN`. `pd` has no
  command reading the credential chain yet — **ticket 03 must promote this gate to `pd auth status`
  against `dist/pd`, in the binary smoke leg of `.github/workflows/ci.yml`**, asserting the run does
  not report the `env` tier. The probe was verified to fail when `autoloadDotenv` is flipped on.
- `test/binary-smoke.test.ts` asserts `pd --version` on a compiled binary for all three stamps —
  the stamp only exists after the build substitutes `PD_VERSION`.
- `src/cli.ts` wires `--version` only; anything else is a placeholder refusal on stderr with exit 2
  until ticket 16 lands the command table.
- Lint is a baseline flat config. The `no-restricted-imports` ban on `**/generated/**` belongs to
  ticket 02, when there is a generated client to ban.
