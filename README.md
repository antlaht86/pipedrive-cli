# pipedrive-cli

`pd` is a read-only Pipedrive CLI for agent harnesses. It issues GET requests only, so it
cannot create, update or delete anything in Pipedrive. Its machine output is NDJSON: one
JSON object per line, closed by a `summary` or `error` trailer that says whether the result
is complete.

The full command and output contract lives in [`AGENTS.md`](AGENTS.md), which is embedded
in the binary and printed by `pd docs`. The vocabulary is in [`CONTEXT.md`](CONTEXT.md) and
the decisions behind it are in [`docs/adr/`](docs/adr/).

## Use

`pd` reads a Pipedrive API token from three tiers, first match wins:

1. `--token-file <path>`
2. `PD_API_TOKEN`
3. `~/.config/pd/credentials` (`%APPDATA%\pd\credentials` on Windows), mode `0600`

Check which tier answered without spending a request:

```bash
pd auth status
```

The grammar is `pd <resource> <verb> [argument] [flags]`. The verbs are `list`, `get` and
`search`.

```bash
pd deals list --limit 20                     # bound the walk; a list is complete by default
pd deals list --fields title,org_id          # narrow the record; id is always emitted
pd organizations list --ids 7,9,11           # the second half of a join
pd deals search Acme --limit 20              # hits, not complete records
pd fields list --entity deal                 # custom field keys and their display names
pd manifest                                  # the exact machine-readable contract
```

A list command fetches everything by default, so pass `--limit` unless you know the result
is small. Reaching the limit is success and the trailer carries `reason: "limit"`.

`--max-requests <n>` is a hard ceiling on network requests and exits 3 rather than
exceeding it. `--resolve` turns ids into names additively, and `--verbose` explains each
request on stderr.

Parse stdout only. stderr is human prose and may change without a version bump. **Never
invoke `--pretty` from an agent**: it emits an unstable human table with no machine-readable
error object.

The token is write-capable even though `pd` is not. Give it a token belonging to a user
with a restricted Pipedrive permission set.

## Build

This repository is the only channel: there is no npm package and no release artifact
([ADR-0021](docs/adr/0021-distribution-build-from-source.md)). Building needs Bun — the
floor is `engines.bun` in `package.json`.

```bash
bun install
bun run build      # -> dist/pd  (dist\pd.exe on Windows)
```

The build prints the output path and the stamped version. Bun compiles `src/cli.ts` into a
single self-contained executable, so the binary needs no Bun and no `node_modules` to run.
Without building, run the same CLI from the checkout with `bun run src/cli.ts <resource>
<verb>`.

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

## Claude Code skill

[`.claude/skills/pd/SKILL.md`](.claude/skills/pd/SKILL.md) is the agent skill for this CLI.
It tells the agent to run `pd docs` before its first command, to bound every list with
`--limit`, to narrow with `--fields`, to parse stdout only, and never to pass `--pretty`.
Working inside this checkout, Claude Code picks it up as is.

To make it available in every project, copy the directory into your personal skills
directory:

```bash
mkdir -p ~/.claude/skills
cp -r .claude/skills/pd ~/.claude/skills/
```

On Windows the same directory is `%USERPROFILE%\.claude\skills\pd`.

The skill assumes `pd` is on your `PATH`; build it first as described above.

## Develop

```bash
bun test                # offline suite; costs zero Pipedrive requests
bun run gates dist/pd   # artifact gates; run bun run build first
bun run typecheck
bun run lint
```

The live suite is deliberately separate and hand-invoked only:

```bash
bun run live [search-term]
```

It uses the normal credential chain, enforces a 30-request ceiling, rewrites
`.scratch/live/responses.json`, and prints a `git diff --no-index` of the previous
recording against the new one. It never runs in CI or as part of `bun test`, and stops
rather than exercising a retry, 429, or Cloudflare block path. Recorded response bodies
contain real CRM data from the account the run points at, so the recording lives in an
ignored directory and is never committed. Request headers are never recorded.

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
