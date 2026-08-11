# Research: distributing a Bun CLI to users who may not have Bun

Ticket: `.scratch/pd-cli-design/issues/07-research-bun-distribution.md`
Date: 2026-08-11
Method: Bun's official docs plus npm's official docs as primary sources; every number labelled **(measured)** was produced on this machine.

Measurement environment (measured): macOS 15.7.7, arm64 (Apple Silicon), Bun 1.3.14, Node v24.19.0, npm bundled with that Node.
Benchmark method: 5 warm-up runs, then 50 timed runs, wall clock divided by 50. Warm filesystem cache. Not `hyperfine` (not installed), so treat the numbers as ±2 ms.
Benchmark subject: a "realistic" `pd`-shaped entrypoint — `zod@4.4.3` + `neverthrow@8.2.0` + `p-limit@7.3.1` imported, `util.parseArgs` used, one `safeParse`, one `JSON.stringify` to stdout. 81 modules bundled.

---

## 1. `bun build --compile`

### 1.1 Cross-compilation: works, from one machine, to every target

Bun documents `--target` for cross-compiling and lists these values
([bun.com/docs/bundler/executables](https://bun.com/docs/bundler/executables)):

`bun-darwin-x64`, `bun-darwin-x64-baseline`, `bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-x64-baseline`, `bun-linux-x64-modern`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`, `bun-windows-x64`, `bun-windows-x64-baseline`, `bun-windows-x64-modern`, `bun-windows-arm64`.

**Verdict: cross-compilation genuinely works, unattended, from a single macOS arm64 box.** (measured) I compiled the realistic entrypoint to five targets in one loop. Every one produced a valid binary for the foreign platform, confirmed by `file(1)`:

| `--target` | build time (measured) | `file` output (measured) |
|---|---|---|
| `bun-linux-x64` | 1.74 s | ELF 64-bit x86-64, dynamically linked, interp `/lib64/ld-linux-x86-64.so.2`, for GNU/Linux 3.2.0 |
| `bun-linux-arm64` | 2.07 s | ELF 64-bit ARM aarch64, interp `/lib/ld-linux-aarch64.so.1`, for GNU/Linux 3.7.0 |
| `bun-linux-x64-musl` | 1.63 s | ELF 64-bit x86-64, interp `/lib/ld-musl-x86_64.so.1` |
| `bun-windows-x64` | 2.57 s | PE32+ executable (console) x86-64 |
| `bun-darwin-x64` | 1.94 s | Mach-O 64-bit executable x86_64 |

The first build per target downloads that target's Bun runtime (~32–39 MB, observed in the `Downloading […]` progress lines). So **CI needs network on the first build per target**, and the download is cached afterwards. No Docker, no QEMU, no per-platform runner.

Caveat straight from the docs: on x64, Bun uses SIMD requiring AVX2; the `-baseline` builds exist for pre-2013 CPUs. "If you or your users see `"Illegal instruction"` errors, you might need to use the baseline version." This matters for `bun-windows-x64` and `bun-linux-x64`, "rarely on Darwin x64".

Windows metadata flags (`--windows-icon`, `title`, `publisher`, …) **cannot be used when cross-compiling**, except `hideConsole` — they depend on Windows APIs. Irrelevant for `pd`.

### 1.2 Output size: ~61–97 MB, and it is essentially all runtime

(measured) darwin-arm64, realistic entrypoint:

| flags | bytes | MiB |
|---|---|---|
| `--compile` | 63,991,010 | 61.0 |
| `--compile --minify` | 63,776,354 | 60.8 |
| `--compile --minify --bytecode` | 66,715,490 | 63.6 |

A `console.log("hello")` one-liner compiles to 63,446,114 B (60.5 MiB) — **identical byte count with `--minify`, `--bytecode` and `--sourcemap` on or off** for a trivial input. So the floor is ~60.5 MiB of embedded Bun runtime; `pd`'s entire dependency graph (zod, neverthrow, p-limit) adds only ~0.3 MiB after minification.

**Size cannot meaningfully be reduced.** `--minify` saved 214 KB (0.3%) on a realistic input. The Bun docs concede this directly: "Overall though, Bun's binary is still way too big and we need to make it smaller." `--bytecode` *increases* size by 2.9 MB.

Per-target sizes (measured, `--minify --bytecode`):

| target | bytes | MiB | gzip -9 (MiB) | zstd -19 (MiB) |
|---|---|---|---|---|
| darwin-arm64 | 66,715,490 | 63.6 | 23.3 | 16.8 |
| darwin-x64 | 72,417,360 | 69.1 | — | — |
| linux-x64-musl | 94,415,136 | 90.0 | — | — |
| linux-arm64 | 96,905,360 | 92.4 | — | — |
| linux-x64 | 97,835,136 | 93.3 | 34.7 | 26.3 |
| windows-x64 | 101,722,624 | 97.0 | 36.9 | 27.9 |

Compression is the only real lever: **a release archive is ~17–28 MB per platform**, roughly a quarter of the raw size. The Linux binaries are reported by `file` as "not stripped"; I did not test whether `strip` is safe on them (see open questions).

### 1.3 Startup time: compiled is faster than `bun file.ts`, but only by ~8 ms

(measured, n=50, warm):

| what | ms/run |
|---|---|
| compiled, realistic, `--minify --bytecode` | **21.5** |
| compiled, realistic, `--minify` | 27.1 |
| compiled, realistic, no flags | 27.8 |
| `bun ./realistic.ts` (source, deps in `node_modules`) | 29.2 |
| compiled, trivial `console.log`, no flags | 14.2 |
| compiled, trivial, `--minify --bytecode` | 16.7 |
| `bun ./trivial.ts` | 17.0 |
| `node -e 'void 0'` (baseline for scale) | 35.8 |

Readings:

- **`--bytecode` is worth it for `pd`**: −5.6 ms (27.1 → 21.5) for +2.9 MB. Bun documents this as moving JavaScriptCore parsing from runtime to build time; it "doesn't obscure source code". It supports both `cjs` and `esm` with `--compile`.
- On a trivial input bytecode *costs* 2.5 ms — the win comes only when there is real code to parse (zod is the bulk here).
- **Compiling buys ~8 ms over running the source under Bun.** That is a real but modest win. The bigger reason to compile is that the user does not need Bun installed, not speed.
- Node 24 on this machine starts a no-op in 35.8 ms — slower than the compiled `pd` binary does actual work. Bun's runtime start is the fast part of this whole picture.

### 1.4 What the compiled binary needs from the host

(measured) `otool -L` on the darwin-arm64 binary lists only OS-provided libraries:

```
/usr/lib/libicucore.A.dylib
/usr/lib/libresolv.9.dylib
/usr/lib/libc++.1.dylib
/usr/lib/libSystem.B.dylib
```

Nothing to install. On Linux (measured, from `file`) the default targets are **dynamically linked against glibc** (`ld-linux-x86-64.so.2`, `for GNU/Linux 3.2.0`) — so they do not run on Alpine. `bun-linux-x64-musl` / `bun-linux-arm64-musl` exist for exactly that and link `ld-musl-x86_64.so.1`. If `pd` ships Linux builds, ship both libc variants or accept "no Alpine".

**Footgun for an agent-invoked CLI (measured + documented):** a compiled executable **auto-loads `.env` and `bunfig.toml` from the process CWD by default** (`tsconfig.json` and `package.json` are off by default). I proved it: a compiled binary printing `process.env.PD_SECRET` printed `leaked` when a `.env` sat in the CWD, and `unset` when built with `--no-compile-autoload-dotenv`. An agent `cd`s into arbitrary repos; any `.env` there would silently change `pd`'s behaviour. **The build should pass `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`** unless `.env` is deliberately part of the credential story. Bun's own docs note these "may also be disabled by default" in a future version, so pinning the flags also protects against that change.

Two other useful knobs for the spec:

- `--define BUILD_VERSION='"1.2.3"'` inlines build-time constants — the clean way to stamp a version into `pd --version` and the command manifest.
- `Bun.isStandaloneExecutable` tells the code at runtime whether it is the compiled binary or `bun src/cli.ts`.
- `BUN_OPTIONS` env var is honoured by standalone executables (e.g. `BUN_OPTIONS="--smol" ./pd`). Note this is an *un-sandboxed* injection point a host environment could set.

### 1.5 macOS code signing: the answer depends entirely on how the user downloads it

This is the sharpest finding, and it is empirical.

**The binary is already ad-hoc signed.** (measured) `codesign -dvvv` on fresh `--compile` output reports `flags=0x20002(adhoc,linker-signed)`, `Signature=adhoc`, `TeamIdentifier=not set`. That ad-hoc signature is what lets it run at all on Apple Silicon. It is *not* a Developer ID signature and it is *not* notarized.

**Fresh compile output fails `codesign -v`.** (measured) `codesign -v --verbose=4 ./pd` → `invalid signature (code or signature have been modified)`. Bun appends its payload after the Mach-O signature, breaking the seal. **Re-signing repairs it**: `codesign --force -s - ./pd` then `codesign -v` → `valid on disk` / `satisfies its Designated Requirement` (measured). This is consistent with Bun documenting `codesign --deep --force -vvvv --sign "XXXXXXXXXX" ./myapp` as the supported flow (requires Bun ≥ 1.2.4), with a recommended `entitlements.plist` granting `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`.

**Unsigned + browser-downloaded = killed outright.** (measured) I set a realistic `com.apple.quarantine` xattr (`0081;…;Safari;<uuid>`) on the binary and ran it:

- Quarantined → process killed, **exit code 137 (SIGKILL)**, no output, no dialog.
- `xattr -d com.apple.quarantine ./pd` → runs normally, exit 0.
- Re-signing ad-hoc (`codesign --force -s -`) while still quarantined → **still killed, exit 137**. Ad-hoc does not satisfy Gatekeeper.
- `spctl -a -vv ./pd` → `invalid signature` either way.

**But `curl` does not set quarantine.** (measured) `curl -sLo file <url>` produced a file with **no `com.apple.quarantine` xattr** at all. So:

| install path | outcome on macOS without Developer ID |
|---|---|
| `curl`/`wget` download, or `install.sh \| sh` | **Works. No Gatekeeper involvement at all.** |
| npm install (npm fetches over HTTP itself) | Works, same reason |
| Homebrew | Works, same reason |
| User clicks a link in Safari/Chrome, then runs it | **SIGKILL, exit 137, silent** |
| Binary inside a `.zip` a user unarchives from a browser download | Quarantine propagates → same SIGKILL |

**Recommendation:** if `pd` is distributed by `curl`-based installer, npm, or Homebrew — the realistic paths for an agent-facing tool — a Developer ID certificate and notarization are **not required**. They become required only if humans are expected to download the binary through a browser. A `$99/yr` Apple Developer account plus a notarization step in CI is the price of that second path; skipping it costs one line of documentation (`xattr -d com.apple.quarantine ./pd`) which most users will never need.

---

## 2. npm as the distribution channel

### 2.1 Does a Bun-targeting package run under Node?

Two separate questions, and the answers differ.

**(a) Code that touches Bun-only APIs: no, hard failure.** (measured)

- `Bun.file("x")` under Node → `ReferenceError: Bun is not defined`.
- `import { Database } from "bun:sqlite"` under Node → `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'`, `code: 'ERR_UNSUPPORTED_ESM_URL_SCHEME'`.

**(b) Bun-free TypeScript source: yes — Node 24 ran it unmodified.** (measured) `node ./realistic.ts --pretty` printed `{"ok":true,"pretty":true}`. Node v24.19.0 strips TypeScript types natively, no `tsx`, no build step, no flags.

**This is directly relevant to `pd`'s locked stack.** `zod`, `neverthrow`, `p-limit`, `util.parseArgs` and `fetch` are all Node-compatible. The generated `@hey-api/openapi-ts` client is plain fetch. If `pd` avoids `Bun.*` and `bun:*` entirely — which the current design has no need for — **the same source runs under both runtimes**, and an npm package would work for Node users at no extra cost. The things that would break this: `bun:sqlite` for the on-disk cache, `Bun.file`, `Bun.password`, `Bun.spawn`, `Bun.$`. Using `node:sqlite` (Node 22+) or plain files instead of `bun:sqlite` keeps the door open. Worth treating as a design constraint to decide deliberately, not to discover late.

### 2.2 Shipping per-platform compiled binaries through npm

The established pattern, verified against real registry metadata rather than blog posts.

npm's package.json documentation ([docs.npmjs.com/cli/v11/configuring-npm/package-json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)) defines:

- `os` — "You can specify which operating systems your module will run on"; host determined by `process.platform`; `!` prefix blocks instead of allows.
- `cpu` — same, via `process.arch`.
- `libc` — "If your code only runs or builds in certain versions of libc, you can specify which ones. This field only applies if `os` is `linux`." **This field exists** — it is the documented way to split glibc vs musl builds.
- `optionalDependencies` — "If a dependency can be used, but you would like npm to proceed if it cannot be found or fails to install, then you may put it in the `optionalDependencies` object."
- `bin` — installs executables into PATH; "linked inside the global bins directory or a cmd (Windows Command File) will be created". Docs note script files "must start with `#!/usr/bin/env node`".
- `engines` — "this field is advisory only and will only produce warnings" unless `engine-strict` is set. So `engines` cannot enforce a runtime.

**The mechanism, confirmed empirically (measured):**

- A **required** dependency whose `os`/`cpu` do not match aborts the install: `npm error notsup Unsupported platform for @esbuild/linux-x64@0.28.2: wanted {"os":"linux","cpu":"x64"} (current: {"os":"darwin","cpu":"arm64"})`.
- The **same package listed in `optionalDependencies`** is silently skipped, and only the matching one installs: with both `@esbuild/linux-x64` and `@esbuild/darwin-arm64` as optional deps, `npm install` on this arm64 Mac reported `added 1 package` — just `@esbuild/darwin-arm64`.

That asymmetry *is* the whole trick: one launcher package lists N platform packages as `optionalDependencies`; npm installs exactly the one that matches.

**Two real-world shapes, read from the live registry (measured):** metadata fetched from
[`registry.npmjs.org/esbuild/latest`](https://registry.npmjs.org/esbuild/latest),
[`registry.npmjs.org/@esbuild%2Fdarwin-arm64/latest`](https://registry.npmjs.org/@esbuild%2Fdarwin-arm64/latest),
[`registry.npmjs.org/@esbuild%2Flinux-x64/latest`](https://registry.npmjs.org/@esbuild%2Flinux-x64/latest) and
[`registry.npmjs.org/bun/latest`](https://registry.npmjs.org/bun/latest).

- `esbuild@0.28.2`: `bin: { "esbuild": "bin/esbuild" }` (contents not inspected — reportedly a small launcher that `exec`s the platform binary) plus **24** `optionalDependencies` `@esbuild/<platform>-<arch>`. Each platform package pins `os` and `cpu` (`@esbuild/darwin-arm64` → `os: ["darwin"], cpu: ["arm64"]`). Notably `libc` is **null** on `@esbuild/linux-x64` — esbuild does not split glibc/musl, because its binaries are static. Bun's are not, so `pd` would need to.
- `bun@1.3.14` itself: `bin: { "bun": "bin/bun.exe", "bunx": "bin/bunx.exe" }`, `os: ["darwin","linux","android","freebsd","win32"]`, `cpu: ["arm64","x64"]`, **16** `optionalDependencies` (`@oven/bun-darwin-aarch64`, `@oven/bun-linux-x64-musl`, `@oven/bun-linux-x64-baseline`, …) **plus** `"postinstall": "node install.js"` as a download fallback. Note that Bun ships separate `-musl` and `-baseline` packages — the same axes that apply to a compiled `pd`.

**Cost for `pd` if this path is taken:** ~5 platform packages (darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl) at 63–93 MB raw each. npm tarballs are gzipped, so ~23–35 MB per package on the wire, and the user downloads exactly one. Publishing is 6 `npm publish` calls per release, version-locked in lockstep. A `postinstall` script is *not* required if `optionalDependencies` is used — that is the point of the pattern, and avoiding `postinstall` matters because `npm install --ignore-scripts` is common in locked-down CI.

**The far cheaper npm option:** if `pd` stays Bun-free per §2.1, publish the **plain JS/TS package** — one tarball of a few hundred KB, `bin` shim with `#!/usr/bin/env node`, runs under Node 20+ and Bun alike. No 63 MB binaries, no per-platform matrix, no signing question at all. This is a genuinely strong option that the "Bun CLI" framing tends to hide.

---

## 3. The shebang script path

(measured) `#!/usr/bin/env bun` on a `.ts` file, `chmod +x`, executed directly → ran, resolved `zod` from `node_modules`, printed correct output, exit 0.

Assumptions it makes about the host: **Bun on `PATH`** (`env` resolves it), the script's dependencies installed and resolvable, and a POSIX host (no Windows). That is all. Zero build step, instant iteration.

For `pd` this is the right *development* shape and a poor *distribution* shape — it requires every user (and every agent harness container) to have Bun installed and a `bun install` to have been run.

---

## 4. Installation, update, and PATH discovery

| option | install | update | on `PATH` how | Windows |
|---|---|---|---|---|
| Compiled binary via `curl \| sh` installer | script downloads one archive, unpacks to `~/.local/bin` or `/usr/local/bin` | re-run installer, or a `pd --version`-driven self-update | the installer's job; standard bin dir | needs a separate PowerShell installer |
| Compiled binary via GitHub Releases (manual) | user downloads + `chmod +x` + moves | manual | user's job — least reliable | manual |
| Compiled binary via npm (`optionalDependencies`) | `npm i -g pd-cli` | `npm i -g pd-cli@latest` | npm links `bin` into the global bin dir, already on PATH | works (npm generates `.cmd` shim) |
| Plain JS package via npm | `npm i -g pd-cli` | same | same | works |
| Homebrew tap | `brew install …` | `brew upgrade` | Homebrew's bin dir | n/a |
| Shebang + `bun install` | clone + `bun install` + symlink | `git pull` | manual symlink | no |

**For agent-harness discovery specifically:** every one of these ends with an executable named `pd` on `PATH`, which is all a harness needs — it shells out to `pd`, it does not care what is behind the name. The npm-global path is the most predictable because the global bin directory is already on `PATH` in nearly every dev container and CI image, and `npx pd-cli` / `bunx pd-cli` gives a zero-install invocation for a harness that cannot install anything. That is a genuine advantage of npm over a compiled-binary-only story: `npx` has no equivalent for a GitHub Release tarball.

---

## 5. Cache location and credential store vs. a single-file binary

Reasoning, not measured — but the constraints are firm and follow from §1.4.

- A compiled binary has **no package directory** to write into. There is no `node_modules/pd/` and no writable location next to the executable (it may live in `/usr/local/bin`, root-owned). All mutable state must go to a runtime-resolved user path: `$XDG_CACHE_HOME/pd` (default `~/.cache/pd`) on Linux, `~/Library/Caches/pd` on macOS, `%LOCALAPPDATA%` on Windows. This is identical for the npm and shebang paths, so **the cache design is unaffected by the distribution choice** — as long as it never assumes a writable install directory.
- Embedded-asset paths (`/$bunfs/root/…`) and `import.meta.dir` inside a compiled binary are **read-only virtual paths**. Anything shipped with the binary (a default config, a bundled field-hash map) can be read but never written. Read-only defaults embedded + writable overrides in the XDG dir is the shape that works everywhere.
- `bun:sqlite` works under `--compile`, but the docs are explicit that a database resolved by relative path resolves **against the process CWD, not the executable's location** — "if the executable is at `/usr/bin/hello` and the user's terminal is in `/home/me/Desktop`, Bun looks for `/home/me/Desktop/my.db`". For an agent that runs `pd` from arbitrary directories this is a bug generator; the cache path must be absolute and CWD-independent. An embedded SQLite DB (`embed: "true"`) is read-write in memory but **all changes are lost on exit** — useless as a cache. And per §2.1, `bun:sqlite` is the single choice that would foreclose Node compatibility; `node:sqlite` or plain files avoid that.
- The credential store faces the same CWD hazard through a different door: `.env` autoloading from CWD (§1.4). If the API token is read from `.env`, the compiled binary picks up *whatever repo the agent happens to be standing in*. Token resolution should be: explicit flag → env var → a file at an absolute path under the user config dir. Never CWD-relative.

---

## 6. Summary of options and their real costs

| option | user needs | size on the wire | startup (measured) | macOS signing | update story | effort |
|---|---|---|---|---|---|---|
| Compiled binary, `curl`-installer / Homebrew | nothing | 17–28 MB compressed per platform | 21.5 ms | **not needed** (curl sets no quarantine) | write an installer + self-update check | medium; 5-target CI matrix, one build machine |
| Compiled binary via npm `optionalDependencies` | Node/npm | one 23–35 MB tarball | 21.5 ms | not needed | `npm i -g @latest`; `npx` works | medium-high; 6 packages per release |
| Plain JS/TS npm package | Node ≥ 20 or Bun | **~a few hundred KB** | ~29 ms under Bun; Node startup ~36 ms baseline | n/a | `npm i -g @latest`; `npx` works | **low**; one package, one publish |
| Browser-downloaded compiled binary | nothing | as above | 21.5 ms | **Developer ID + notarization required, or exit 137 SIGKILL** | manual | high (Apple account, CI notarization) |
| Shebang script | Bun + repo + `bun install` | n/a | ~29 ms | n/a | `git pull` | trivial, but not distribution |

The interesting finding is that the two ends of this table are much cheaper than the middle. Compiled-binary-via-curl costs a CI matrix and no signing; plain-npm-package costs almost nothing *if* `pd` stays free of `Bun.*` and `bun:*` — which nothing in the locked design requires it to violate. The 63 MB binary buys ~8 ms of startup and independence from an installed runtime; whether that is worth a per-platform release pipeline is the actual decision.

---

## Open questions / not documented

1. **Developer ID signing was not verified end-to-end.** This machine has `0 valid identities found` for code signing. I proved that re-signing repairs `codesign -v`, and Bun documents the Developer ID flow, but I could not confirm that a Developer-ID-signed, notarized `bun --compile` binary passes `spctl` and survives quarantine. Bun's docs do not mention notarization at all — only `codesign`. Notarization of a binary containing a JIT is the part most likely to have surprises.
2. **`strip` on the Linux binaries.** `file` reports them "not stripped". Whether stripping is safe (Bun locates its embedded payload by offset) and how much it saves is untested. Bun's docs do not address it.
3. **Whether the SIGKILL is stable across macOS versions.** Measured on 15.7.7 arm64. The behaviour on Intel Macs (where ad-hoc signing is not mandatory) is likely to be a Gatekeeper *dialog* rather than a silent kill, but I did not test it.
4. **Actual Linux/Windows execution.** Cross-compiled binaries were verified structurally (`file`) but never run — no VM was used, per scope. The glibc-version floor (`for GNU/Linux 3.2.0`) is from the ELF header, not from a runtime test on an old distro.
5. **npm tarball size limits.** npm's docs do not state a hard per-package size limit that I could cite; a 93 MB Linux binary compresses to ~35 MB, which is large but under any commonly reported threshold. Unverified against npm's actual policy.
6. **`libc` field support across package managers.** npm documents `libc`. Whether `bun install`, `pnpm` and `yarn` all honour it identically for musl discrimination is untested — esbuild sidesteps the question with static binaries, so it is not a proven-in-the-wild pattern the way `os`/`cpu` is.
7. **Whether Bun's runtime download for cross-compilation can be pre-seeded** in an offline CI image. The download happened transparently; the cache location and how to prime it are not documented on the executables page.
8. **`BUN_BE_BUN=1`** makes any compiled binary act as the full `bun` CLI. For a tool whose safety property is "read-only, cannot damage the CRM", it is worth confirming this cannot be used to sidestep anything — it does not expose `pd`'s credentials or bypass its HTTP layer, but it does mean the shipped `pd` binary is also a general-purpose JavaScript runtime and package installer on the user's machine. Not a `pd` vulnerability; possibly a note for a security-conscious reviewer.
