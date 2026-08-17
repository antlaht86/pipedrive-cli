# Using `pd` from an agent

`pd` is a read-only Pipedrive CLI for agent harnesses. It issues GET requests only. Its stable machine output is NDJSON: consume one JSON object per line and use the final `summary` or `error` trailer to decide whether the result is complete.

## Install and update

Clone the private repository and build with Bun 1.3.14 or newer:

```sh
git clone https://github.com/antlaht86/pipedrive-cli.git
cd pipedrive-cli
bun install
bun run build             # writes dist/pd (dist\pd.exe on Windows)
```

`pd` performs no installation step. Putting `dist/pd` on `PATH` is your responsibility and the destination is your choice; for example, `cp dist/pd ~/.local/bin/`. `pd` never checks for updates or updates itself. Update the checkout deliberately with `git pull`, then run `bun run build` again.

## Command surface

The resource grammar is:

```text
pd <resource> <verb> [arg] [flags]
```

The three verbs are `list`, `get`, and `search`. The ten resources are `deals`, `persons`, `organizations`, `activities`, `products`, `pipelines`, `stages`, `users`, `fields`, and `items`. `search` exists for deals, persons, organizations, products, and items; `items` has neither `list` nor `get`. Run `pd manifest` for the exact command, flag, selectable-field, error-code, and warning-kind contract.

The named commands outside the resource grammar are `pd manifest`, `pd cache info`, `pd cache clear`, `pd auth status`, and `pd docs`. The named non-NDJSON stdout commands are `pd --help`, `pd manifest`, `pd auth status`, `pd cache info`, `pd docs`, and `pd --version`.

Entity search is a distinct verb: `pd deals search Acme`. Search lines are **hits**, not complete records, and are tagged accordingly (for example, `deal_search_hit`). A bounded search returns the best matches first, so `--limit 20` is usually useful. `--search-in` chooses which upstream fields Pipedrive searches; `--fields` chooses which fields `pd` emits. They do not do the same job.

An activity record's upstream `type` field is emitted as `activity_type`; `type` is reserved for the NDJSON line discriminator.

## Bound output before reading it

List commands fetch the complete result by default. Pass `--limit` unless you know the result is small. Reaching `--limit` is successful and produces a partial summary with `reason: "limit"`.

An unbounded list writes a human warning to stderr at every 10,000 emitted records, but that warning may never arrive at an agent: a harness may discard stderr. Do not use it as a bound. Pass `--limit` instead.

`--fields <name>[,<name>…]` narrows record width. `id` is always emitted. Select top-level names directly; select one custom field as `custom_fields.<hash>`. Learn hashes and display names together with:

```sh
pd fields list --entity deal
```

Display names are not selectors because they can collide. With `--resolve`, selecting a raw id or custom field also emits its resolution artifact; the raw value remains.

A custom field with no value is absent from `custom_fields`, so the block holds only the fields this record fills. An account defines many more than a record uses. Read `pd fields list --entity <entity>` to learn every custom field the account has. A selected hash that is empty in every record of the run produces `"custom_fields":{}` and one warning with `kind: "unmatched_field_selector"`.

A record line carries whatever Pipedrive sent, so a field newer than this build may appear in full output and still be refused by `--fields`, exit 2. The selectable list is a floor, not a ceiling: read a record to learn what a resource actually holds, and `pd manifest` to learn what `--fields` accepts.

**Never invoke `--pretty` from an agent.** It emits an unstable human table with no machine-readable error object; its wording, columns, and alignment may change in any release.

## Credentials and security

Credential precedence is:

1. `--token-file <path>`
2. `PD_API_TOKEN`
3. the per-user credentials file

The first match wins. A named `--token-file` that cannot be resolved is a usage error (exit 2); `pd` never silently falls back from it. If no tier resolves, `pd` reports `code: "auth"`, exits 1, and its message names all three tiers. Use `pd auth status` to inspect the chosen tier and token fingerprint without making a Pipedrive request.

The credentials file is `$XDG_CONFIG_HOME/pd/credentials`, defaulting to `~/.config/pd/credentials`, on POSIX and `%APPDATA%\pd\credentials` on Windows. It must be mode `0600` on POSIX. Per-user directories are:

| Purpose | POSIX | Windows |
| --- | --- | --- |
| Config | `$XDG_CONFIG_HOME/pd/`, default `~/.config/pd/` | `%APPDATA%\pd\` |
| Cache | `$XDG_CACHE_HOME/pd/<token-hash>/`, default `~/.cache/pd/<token-hash>/` | `%LOCALAPPDATA%\pd\<token-hash>\` |

A Pipedrive API token is write-capable. `pd` refuses writes in its own code, but Pipedrive does not make the credential read-only. Handing `pd` an administrator's token gives a fully privileged credential to a program whose safety rests on its own correctness. Use a token belonging to a user with a restricted Pipedrive permission set for account-level protection; configuring that permission set is Pipedrive account administration and is outside `pd`.

## Request and budget safety

`--max-requests <n>` is an optional hard ceiling on network requests. Cache hits cost zero against it. It has no default and aborts before the ceiling is exceeded. `--resolve-budget <n>` controls only variable-cost relation resolution; exhaustion degrades enrichment rather than aborting the requested walk.

`pd` makes no promise about the company's shared daily API-token budget. It minimises cost per unit of work and stops hard when it recognises a company-wide block, but budget stewardship remains a human responsibility through Pipedrive's API Usage Dashboard. There is no budget guard that can coordinate all integrations.

Rate gates and retry budgets are process-local. Parallel `pd` invocations against one credential are not free: they share Pipedrive's burst and daily allowances, and enough concurrent processes can rate-limit one another. Prefer bounded, sequential joins over unconstrained fan-out.

## Fetch related records with a join

`pd` never expands or includes another entity's complete record automatically. The design is a two-command join: project the foreign key, then fetch those records explicitly.

```sh
pd deals list --fields title,org_id
pd organizations list --ids 7,9,11
```

`--ids` accepts any number of IDs. `pd` deduplicates them, hides Pipedrive's 100-ID request boundary, and preserves the caller's order. An `unmatched_ids` warning means requested records do not exist or are not visible. This keeps each half a normal command with its own fields, completeness trailer, and request accounting.

## Output and diagnostics

Parse stdout only. stderr is human prose, not an output contract: **do not parse stderr** or depend on receiving it. Its content and wording may change without a version bump. Pass `--limit` rather than watching stderr for the 10,000-record warning.

Missing values are omitted as keys rather than emitted as `null`, including inside nested objects and arrays of objects. Array elements themselves are never removed merely because fields inside them are absent. Money remains JSON numbers, timestamps pass through unchanged, and `expected_close_date`, `due_date`, and `due_time` are account-local wall-clock values that `pd` does not interpret.
