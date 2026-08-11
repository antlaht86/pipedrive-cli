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
