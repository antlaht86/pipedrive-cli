# Project instructions

## Agent-facing `pd` documentation

For the installed CLI's command and output contract, read [AGENTS.md](AGENTS.md). It is the canonical harness-agnostic documentation and is embedded by `bun run build` for `pd docs`.

## Libraries

- Use `neverthrow` for error handling. Return `Result`/`ResultAsync` instead of throwing. Do not use `try`/`catch` in application code — wrap third-party throws at the boundary with `fromThrowable` / `fromPromise`.
- Use `zod` for all runtime validation. Parse external input (API responses, CLI arguments, environment variables, files) at the boundary. Derive TypeScript types with `z.infer` instead of writing them twice.

## Documentation lookup

When you are not sure about the correct syntax or API of a library, framework, SDK, or CLI tool, use the `context7` MCP server to fetch the current documentation. Do this before you write the code, even for well-known libraries — your training data can be out of date. Prefer `context7` over web search for library documentation.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary; each label string equals its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
