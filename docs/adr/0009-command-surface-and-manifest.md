# ADR-0009: The command surface, its vocabulary, and the manifest

Status: accepted
Date: 2026-08-12
Extends: [ADR-0007](0007-the-narrow-v1-users-client.md) §5 — `pd users list` / `pd users get <id>` were written as illustration; this ADR makes the grammar they used normative
Closes: [ADR-0008](0008-resolution-mechanics.md)'s open question about whether `pd fields list` exists
Reconciles: [ADR-0005](0005-cache-design.md) §7 — `pd cache info` and `pd cache clear` predate the grammar and are made explicit exceptions to it

## Context

An agent composes `pd` invocations rather than typing them. It reads the manifest, or it reads
`--help`, and then it constructs a command string. Every ambiguity in the surface is a turn it wastes
and a token budget it spends on a retry.

Four facts fixed the ground before any choice was made.

**The readable surface is 30 v2 paths plus one v1 operation.** Enumerated mechanically from
`paths` in `openapi-v2.yaml`: activities, activityFields, deals (+ archived, products, search,
installments), dealFields, persons, personFields, organizations, organizationFields, products
(+ search), productFields, leads/search, itemSearch (+ field), stages, pipelines, projectFields,
projects (+ archived, search), projectTemplates, tasks, boards, phases, and the per-record `{id}`,
followers and changelog paths. [ADR-0007](0007-the-narrow-v1-users-client.md) adds `GET /users`.

**Prior ADRs already put commands on the surface.** ADR-0005 §7 specified `pd cache info` and
`pd cache clear`. ADR-0007 §5 wrote `pd users list` and `pd users get <id>`. The grammar chosen here
had to accommodate what was already promised, not overwrite it.

**Six flags are already global**, from the locked notes and from ADR-0003, ADR-0007 and ADR-0008:
`--pretty`, `--no-cache`, `--max-requests`, `--limit`, `--resolve`, `--resolve-budget`. Four more are
owned by tickets still open — projection (25), concurrency (17), budget floor (16), credentials (20) —
so the surface leaves room for them and this ADR decides none of them.

**`--help` already breaks the NDJSON contract.** Locked note 4 puts `--help` on every subcommand, and
help text is prose on stdout. The question for the manifest was therefore not whether an exception
exists, but whether a second one is justified.

## Decision

### 1. The grammar is `pd <resource> <verb> [id] [flags]`

Resource first, verb second. `pd deals list`, `pd deals get 123`, `pd persons list`,
`pd users get 42`.

Verb-first (`pd list deals`, `pd get deal 123`) was the strongest rival: it makes the read-only
property structural, because the verb inventory *is* the whole story and there is no third verb. It
was rejected on help pagination — `pd get --help` must then list every resource on one page, whereas
`pd deals --help` under the chosen grammar is a natural, resource-scoped page that an agent can read
without loading the rest of the tool. Section 6 recovers the read-only legibility that verb-first
would have given for free.

A flat `pd deals` / `pd deal 123` was rejected because the argument is then positional and untyped:
`pd deals 123` is a plausible construction that means nothing, and there is no place to hang
resource-scoped help.

The plural-noun-singular-result mismatch of `pd deals get 123` is accepted. It is the one blemish,
and it is smaller than the two costs above.

### 2. The first surface is nine resources

`deals`, `persons`, `organizations`, `activities`, `products`, `pipelines`, `stages`, `users`,
`fields`.

Deliberately absent, and not because they are unreachable: projects, tasks, boards, phases,
projectTemplates, the deal children (products, discounts, installments), followers and their
changelogs, and the `archived` variants. They are not out of scope — the map's Out of scope section
does not gain an entry — they are simply not in the *first* surface, and a later effort may add them
without reopening anything here.

One consequence is worth stating because it was chosen, not overlooked: with no `projects` command,
`/projectFields` stays outside [ADR-0005](0005-cache-design.md)'s cache list. ADR-0008's rule
("every v2 `*Fields` schema, 24 h") would have admitted it automatically had projects shipped. The
cache stays at eight entries.

Search (`/deals/search`, `/itemSearch`, and siblings) is absent for a different reason: it is the
map's *Filtering and search surface* question, which was waiting on this ticket and is now
unblocked.

### 3. Every resource has `list` and `get`; cached resources answer `get` locally

`get` exists wherever v2 offers a by-id path. For the four resources that are cached —
`users`, `fields`, `pipelines`, `stages` — `get` filters the cached list rather than issuing a
request, and reports `requests: 0` on a warm cache. This generalises ADR-0007 §5, which made exactly
this trade for `pd users get`.

`fields` is the one resource whose id is not an integer: `pd fields get --entity deal <field_code>`.

### 4. `pd fields list --entity <name>` exists, and `--entity` is required

ADR-0008 named a hypothetical `pd fields list` and left its existence here. It exists.

Without it, an account's custom field hashes are unobtainable: `--resolve` names them one record at
a time, and there is no other route to "which custom fields does this account have". The schemas are
already cached, so on a warm cache the command costs nothing.

`--entity` takes one of `deal`, `person`, `organization`, `product`, `activity` and is **required**.
Omitting it is a usage error, exit 2. Defaulting to all five was rejected: it makes the heaviest
output the default, which an agent reaches for precisely when it does not yet know what to ask.
The manifest enumerates the permitted values, so nothing is left to guess.

### 5. The nouns are Pipedrive's, and there are no aliases or short flags

`persons`, not `people`. `organizations`, not `orgs`. No `-p` for `--pretty`, no synonyms, one
spelling per concept.

An agent that has seen Pipedrive's documentation transfers that knowledge directly, and the command
then matches its own output: `pd persons list` emits records carrying `person_id`. Aliases were
rejected because the manifest must either list them — handing the agent a coin flip — or hide them,
making them undocumented surface. This is the locked "agent wins" policy applied, not a fresh
decision.

### 6. Read-only is legible on three channels

1. **`--help`**, first line of the root page: `pd is read-only. It issues GET requests only. It
   cannot create, update or delete anything in Pipedrive.`
2. **The manifest**: `"read_only": true`, with the scope stated in the adjacent
   `"read_only_scope": "pipedrive_api"`.
3. **An unknown command teaches rather than merely refuses.** Any unrecognised command exits 2 with
   `code: "unknown_command"` and a message saying `pd` has no write commands at all, pointing at
   `pd manifest` for the real surface. One probe ends the search; a generic error invites an agent
   to try `update`, then `delete`, then `new`.

The refusal message must **not** claim "the only verbs are list and get" — section 8 makes that
false. It names the absence of writes, and delegates the inventory to the manifest.

The scope wording is load-bearing and comes from ADR-0005 §7: read-only is a property of what `pd`
does to the *Pipedrive API*. `pd cache clear` deletes local files, and that is not a violation.

### 7. `pd manifest` emits one JSON object

A subcommand, not a flag and not a committed file.

A flag (`pd --manifest`) would be a global flag that is not global: `pd deals list --manifest` must
then be an error, so the parser special-cases it and the manifest's own flag table has to mark it.
A committed `manifest.json` was rejected on distribution grounds — research 07's curl-installed
compiled binary ships no adjacent files, so the mechanism does not exist for half the install
methods, and where it does exist it can drift from the installed binary.

The output is **one JSON object**, not NDJSON. `JSON.parse(stdout)` works. There is no `summary`
trailer, no `complete`, no `emitted`.

This is the second documented exception to ADR-0002's "stdout is NDJSON", and it is the same
exception as `--help`: neither is a record stream, neither can be partial, and neither has anything
for a trailer to report. The rule is restated as **data commands emit NDJSON**; `--help` and
`pd manifest` are surface introspection and stand outside it.

Emitting the manifest as NDJSON — a line per command plus a trailer — was rejected because the
global parts (exit codes, the output contract, global flags) are not commands and would need
invented line types, leaving the harness to reassemble the document. A single-line NDJSON manifest
plus trailer was rejected as the worse half of both: the invariant survives, but `JSON.parse(stdout)`
still fails.

### 8. Three groups sit outside the grammar, by name

*Amended by [ADR-0012](0012-authentication-and-credential-resolution.md) §5, which added the third.*

`pd manifest` is verbless. `pd cache info` and `pd cache clear` (ADR-0005 §7) use verbs that are not
`list` or `get`, on a noun that is not a Pipedrive resource. `pd auth status` (ADR-0012 §5) does the
same on a second such noun, and like `pd manifest` it emits one JSON object rather than an NDJSON
stream.

These are the complete set of exceptions, and they are exceptions rather than a generalisation: the
grammar governs *resources*, and neither the surface description, the local cache, nor the credential
configuration is one. The
root `--help` therefore has two sections, `RESOURCES` and `OTHER`, and the manifest carries the same
split so an agent constructing a resource command never sees `manifest` in the candidate list.

### 9. `manifest_version` is an integer, incremented only by a breaking change

Adding a command, a flag or a field does not increment it; removing or repurposing one does. A
harness compares one integer against the highest it knows and refuses a larger one, and otherwise
ignores keys it does not recognise.

Semver was rejected: the harness's only question is "can I read this", which is a yes or no, and
three numbers make it implement comparison logic to answer it.

The manifest also carries `"version"`, the binary's own release version, which is orthogonal and
changes on every release.

### 10. What the manifest must express

Beyond command names, arguments and flags:

- the output format, declared **once globally** as NDJSON (ADR-0002 §, restated here)
- the vocabularies an agent must branch on: `type` line kinds (`record`, `warning`, `summary`,
  `error`), the `resolved` values `none` / `partial` / `full` (ADR-0008 §11), the exit codes 0/1/2/3
  and the `code` union (ADR-0001)
- the trailer fields `complete`, `emitted`, `skipped`, `duplicates`, `resolved`, `requests`
- per command, `delivery: "streams" | "collects"` (ADR-0004), because a collected command's
  time-to-first-byte is its total wall time
- `read_only` and `read_only_scope` (section 6)
- for `--pretty`, an explicit `"machine_readable": false` and the instruction never to invoke it from
  an agent — ADR-0002's hand-on to `AGENTS.md`, repeated where the agent actually looks

It must **not** express a per-command request cost. `pd users get 42` legitimately costs zero
requests on a warm cache, so any promised cost would be a lie the agent could budget against.

## Assumptions recorded rather than asked

These are implementation-level and were decided rather than put to the user, per the map's altitude
rule.

- **The manifest and every `--help` text are generated from one in-code command table**, so they
  cannot drift. Nothing else guards the two against each other.
- **`--help` and `pd manifest` write to stdout and exit 0.** They are successful runs, not usage
  errors.
- **Records carry `record_type` in the singular** (`"deal"` for `pd deals list`). It is the only
  singular/plural mapping on the surface; an agent inverting it has exactly one rule to learn.

## Consequences

- `AGENTS.md` gains the grammar, the nine resources, the two exception groups, and the sentence that
  an agent must never pass `--pretty`.
- The map's *Manifest schema and its versioning* fog is closed. What remains — the field-by-field
  shape — is what ticket 22 writes when it assembles the spec, not a decision.
- The map's *Filtering and search surface* fog is unblocked. It was waiting on the command surface,
  and now has a grammar to be expressed in.
- ADR-0005's `pd cache info` / `pd cache clear` survive unchanged, now recorded as grammar
  exceptions rather than as an unnoticed inconsistency.
- `pd fields list` and `pd fields get` are new commands ADR-0008 anticipated but did not create. They
  read only cached data and add no request in the warm case.
- Four flags from open tickets (25, 17, 16, 20) must slot into the global flag table without
  reshaping it. The table is a flat list with no per-command overrides, so each is an append.
- The first surface omits projects, deal children, followers and archived variants. Adding any of
  them later is additive under section 9 and does not increment `manifest_version`.
