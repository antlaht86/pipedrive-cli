# Command surface, naming, and the machine-readable manifest

Type: prototype
Status: resolved

Blocked by: 10, 11, 18

## Question

An agent composes these commands rather than typing them. What do they look like?

Draft the surface concretely — a listing of commands with their flags, a sample manifest, and a sample `--help` output — and react to it as an agent reading it cold for the first time.

- The shape: `pd deals list`, `pd get deal 123`, `pd list deals`, or a flat `pd deals`. Which reads least ambiguously to a model that has never seen this tool and is working from the manifest alone?
- Whether short flags and aliases exist at all. A human wants `-p`; an agent wants one obvious spelling and no choices. Locked policy says the agent wins.
- Naming consistency with Pipedrive's own vocabulary versus naming that reads well as a command. Deal, person, organization, activity, lead, note — where they disagree, which wins.
- The manifest: what a harness needs to discover the full surface without guessing. Command names, flags, types, defaults, which output formats each supports, exit codes, and examples. How it is emitted — a subcommand, a flag, a committed file.
- Whether the manifest is generated from the same source as `--help` so the two cannot drift.
- Which global flags apply to every command (`--pretty`, `--no-cache`, `--max-requests`, and whatever tickets 11, 15 and 20 add) and how the manifest expresses that.
- How the read-only guarantee is made legible in the surface itself, so an agent does not waste turns probing for a write command that does not exist.
- Which resources ship in the first surface, given ticket 18's answer on v1.

Produce the draft surface and manifest as assets and link them from this ticket.

## Context added while resolving other tickets

- [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) answers the last bullet. The v1
  question is closed: **`users` is the only v1 resource**, and it ships as two commands,
  `pd users list` and `pd users get <id>`. Leads, notes, currencies, activity types and filters are
  out of scope, so the first surface is the v2 resources plus `users`.
- ADR-0007 also adds a global flag, `--resolve`, and **retires the name `--resolve-fields`** used in
  ADR-0005. The manifest and every `--help` must spell it `--resolve`.
- `pd users get <id>` is the first command that can legitimately report `requests: 0`, because it is
  answered entirely from cache. If the manifest expresses per-command request cost, it cannot promise
  a request per command.
- ADR-0007 excluded seven `users` endpoints (`/users/{id}`, `/users/me`, `/users/find`, followers,
  permissions, role assignments, role settings). The surface must not imply they exist.

- [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) leaves this ticket two loose ends. First,
  it names a hypothetical `pd fields list` when drawing the line between an enrichment that degrades
  and an answer that fails — whether such a command exists is this ticket's call, not ADR-0008's.
  Second, `/projectFields` exists in v2 and is deliberately absent from the cache list; ADR-0008's
  rule ("every v2 `*Fields` schema, 24 h") admits it automatically if this ticket gives projects a
  command surface, so no cache decision has to be reopened either way.
- `--resolve-budget <n>` joins `--max-requests` as a global flag the surface must carry, and the
  `summary` trailer now always carries `resolved`.

## Answer

Recorded in full as [ADR-0009: The command surface, its vocabulary, and the manifest](../../../docs/adr/0009-command-surface-and-manifest.md).
Assets: [`prototypes/19-command-surface/`](../prototypes/19-command-surface/) — `surface-draft.md`
(the draft reacted to, with every fork's outcome), `manifest.sample.json` and `help-samples.txt`
(the locked surface, normative), `cold-read.md` (what an agent reading the manifest alone misreads).

In gist:

- **The grammar is `pd <resource> <verb> [id] [flags]`** — resource first. Verb-first was the
  strongest rival because it makes read-only structural, but it forces `pd get --help` to list every
  resource on one page; resource-first gives an agent a page it can read without loading the rest of
  the tool. Section 6 of the ADR recovers the legibility verb-first would have given free.
- **Nine resources ship**: deals, persons, organizations, activities, products, pipelines, stages,
  users, fields. Projects, tasks, boards, phases, deal children, followers and archived variants are
  *not in the first surface* — not out of scope, so no Out-of-scope entry is earned. One chosen
  consequence: with no `projects` command, `/projectFields` stays outside ADR-0005's cache, which
  therefore stays at eight entries.
- **`pd fields list --entity <name>` exists**, closing ADR-0008's open question. `--entity` is
  required and omitting it is exit 2; defaulting to all five entities would make the heaviest output
  the default an unsure agent reaches for. Without the command, an account's custom field hashes are
  unobtainable except one record at a time through `--resolve`.
- **Every resource has `list` and `get`**, and the four cached ones — users, fields, pipelines,
  stages — answer `get` by filtering the cached list, reporting `requests: 0`. This generalises
  ADR-0007 §5 rather than inventing anything.
- **Pipedrive's nouns win**: `persons`, `organizations`, no `people`, no `orgs`, no aliases and no
  short flags. The command then matches its own output — `pd persons list` emits `person_id`.
- **`pd manifest` is a subcommand emitting one JSON object**, so `JSON.parse(stdout)` works. This is
  the second exception to ADR-0002's NDJSON rule, on the same grounds as `--help`: neither is a
  record stream, neither can be partial, neither has anything for a trailer to report. The rule is
  restated as *data commands emit NDJSON*.
- **`manifest_version` is an integer**, incremented only by a breaking change. Adding a command or
  flag does not move it.
- **Read-only is legible on three channels** — the first line of `pd --help`, `"read_only": true`
  with `"read_only_scope": "pipedrive_api"`, and an `unknown_command` refusal that says no write
  command exists at all and points at `pd manifest`. One probe ends the search.

One inconsistency this ticket found and fixed: **ADR-0005 §7 had already created `pd cache info` and
`pd cache clear`**, which break the grammar and falsify the drafted refusal message "the only verbs
are list and get". ADR-0009 §8 records `pd manifest` and the `pd cache` pair as the complete set of
grammar exceptions, and the refusal message now names the absence of writes and delegates the
inventory to the manifest.

Decided rather than asked, per the map's altitude rule: manifest and `--help` generate from one
in-code command table; both write to stdout and exit 0; `record_type` is singular.

What this hands onward:

- The fog patch *Manifest schema and its versioning* **closes**. What is left is the field-by-field
  shape, which [ticket 22](22-task-assemble-the-spec.md) writes when it assembles the spec.
- The fog patch *Filtering and search surface* is **unblocked** and now has a grammar to be expressed
  in. Search endpoints (`/deals/search`, `/itemSearch` and siblings) were deliberately left out of
  the first surface for that reason.
- [Ticket 25](25-grilling-field-projection.md) inherits a flat global flag table with no per-command
  overrides, so `--fields` is an append rather than a reshape. The same holds for tickets 16, 17
  and 20.
