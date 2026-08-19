---
name: pd
description: Read Pipedrive CRM data with the `pd` CLI. Use when the task needs deals, persons, organizations, activities, products, pipelines, stages, users, or custom fields from Pipedrive — listing, getting by id, searching, or joining across entities.
---

# `pd` — read-only Pipedrive CLI

`pd` answers Pipedrive questions from the shell. It issues GET requests only and emits NDJSON on stdout.

## Read the contract first

Run `pd docs` before the first command of a session. It prints the full agent-facing contract: command grammar, field projection, credentials, budget safety, and the join pattern. Run `pd manifest` for the exact machine list of commands, flags, selectable fields, error codes, and warning kinds.

Do not answer a Pipedrive question from memory of a previous session's flags — `pd docs` is the live source.

If `pd` is not on `PATH`, tell the user to build it: clone `https://github.com/antlaht86/pipedrive-cli.git`, `bun install`, `bun run build`, then put `dist/pd` on `PATH`. Do not attempt a package-manager install; there is none.

## Guardrails that apply before the docs land

- **Bound every list.** Pass `--limit`. An unbounded list fetches the complete result and spends the company's shared daily API budget.
- **Parse stdout only.** One JSON object per line; the final `summary` or `error` trailer says whether the result is complete. stderr is human prose with no contract — never parse it, never depend on receiving it.
- **Never pass `--pretty`.** It emits an unstable human table with no machine-readable error object.
- **Narrow with `--fields`.** Full records are wide; select the names the task needs.

## Reporting

Answer from the parsed records. When the trailer reports partiality (`reason: "limit"`) or warnings (`unmatched_ids`, `unmatched_field_selector`), say so — a bounded answer presented as complete is the failure mode here.
