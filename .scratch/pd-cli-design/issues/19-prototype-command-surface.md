# Command surface, naming, and the machine-readable manifest

Type: prototype
Status: open

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
