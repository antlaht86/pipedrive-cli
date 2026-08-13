# pipedrive-cli

`pd` — a read-only Pipedrive CLI for agents. See [`CONTEXT.md`](CONTEXT.md) and the
decision records under [`docs/adr/`](docs/adr/).

## Build

This repository is the only channel: there is no npm package and no release artifact
([ADR-0021](docs/adr/0021-distribution-build-from-source.md)). Building needs Bun — the
floor is `engines.bun` in `package.json`.

```bash
bun install
bun run build      # -> dist/pd  (dist\pd.exe on Windows)
```

The build writes into the checkout and stops. Putting `dist/pd` on your `PATH` is your
business, for example:

```bash
cp dist/pd ~/.local/bin/
```

`pd --version` names the commit the binary was built from: `1.0.0` from a clean checkout
at a release tag, `1.0.0+g3f9a1c2` off a tag, `1.0.0+g3f9a1c2.dirty` with local changes.

`pd` never updates itself. Updating is `git pull && bun run build`.

On macOS `codesign -v` reports an invalid signature on fresh `--compile` output, because
Bun appends its payload after the signature. The binary runs as built and the project
does not re-sign it.

## Develop

```bash
bun test           # the suite, lint gates included; costs zero Pipedrive requests
bun run typecheck
bun run lint
```
