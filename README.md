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
bun test           # the suite and the CI gates; costs zero Pipedrive requests
bun run typecheck
bun run lint
```

### Regenerating the Pipedrive clients

```bash
bun run openapi-ts
```

This reads Pipedrive's two published OpenAPI documents and rewrites
`src/lib/pipedrive/v2/generated/` and `src/lib/pipedrive/v1/generated/`. It makes no
Pipedrive API call and costs nothing from the shared daily budget. The output is
committed; review the diff like any other change.

**Never hand-edit a file under `generated/`.** A regeneration overwrites it. Spec
corrections belong in `parser.patch` in `openapi-ts.config.ts`, which patches Pipedrive's
document before generation, so the types and the zod schemas are corrected together.

Two settings in that config are a safety property rather than a preference, per
[ADR-0013](docs/adr/0013-read-only-enforcement.md) §1:

- `parser.filters.operations.include: ['/^GET /']` — a write operation is never
  generated, so no call site can reach one.
- `sdk.client: false` — no ambient client exists, so a generated function cannot be
  called without being handed the client the wrapper module built.

`bun test` fails the build if a regeneration reintroduces a non-GET operation into either
client. If that happens, do not edit the generated file: find out why the filter stopped
holding.

The dependency versions are pinned exactly, because the generator's configuration surface
changes between minor releases. Regenerating with a different version is a deliberate
upgrade, with its own review of the diff.
