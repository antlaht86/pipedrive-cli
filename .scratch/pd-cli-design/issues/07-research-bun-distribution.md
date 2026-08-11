# Distributing a Bun CLI to users who may not have Bun

Type: research
Status: resolved

## Question

What are the real distribution options and their costs?

- `bun build --compile`: output size, startup time, whether cross-compilation to other platforms and architectures works from one machine, and what the resulting binary needs from the host.
- Publishing to npm: whether a Bun-targeting package runs under Node, what breaks if it does not, and whether the compiled binary can be shipped through npm per-platform.
- The shebang script path, and what it assumes about the host.
- How each option is installed and updated, and how an agent harness would discover the executable on `PATH`.
- Whether any option can be code-signed or notarized on macOS, and what happens without it.
- How the on-disk cache location and the credential store interact with a single-file binary.

Feeds the distribution decision.

## Answer

Findings: [research/07-bun-distribution.md](../research/07-bun-distribution.md), with a measured cost table in its section 6.

**The two ends of the option table are much cheaper than the middle.**

A **plain JS/TS npm package** is a few hundred KB, needs Node ≥ 20 or Bun, starts in ~29 ms, and costs almost nothing to publish — *provided `pd` stays free of `Bun.*` and `bun:*` APIs*. Nothing in the locked design requires violating that. Note the tension with the credential-storage findings, which recommend `Bun.secrets`.

A **compiled binary behind a curl installer or Homebrew** needs nothing from the user, ships 17–28 MB compressed per platform, starts in 21.5 ms, and — because curl sets no quarantine attribute — **needs no code signing**. Cross-compilation to every target works from one machine. The cost is a five-target CI matrix.

The middle options are worse: a browser-downloaded binary **requires Developer ID signing and notarization or it is SIGKILLed**, and npm `optionalDependencies` means six packages per release.

So the compiled binary buys ~8 ms of startup and independence from an installed runtime, for a per-platform release pipeline. Whether that trade is worth taking is the decision.
