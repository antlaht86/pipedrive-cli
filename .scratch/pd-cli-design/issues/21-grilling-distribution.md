# Distribution

Type: grilling
Status: open

Blocked by: 07

## Question

How does `pd` reach a machine, given users may not have Bun installed?

- Compiled binary, npm package, or shebang script, on ticket 07's findings. Weigh install friction, update path, startup time and binary size.
- Whose machine is the target: a developer's laptop, a CI runner, an agent harness's container. Each has a different tolerance for a missing runtime.
- How an agent harness discovers the executable, and whether install location is something the documentation must pin down.
- Cross-platform coverage, and whether an unsigned macOS binary is a practical problem.
- The update story, and whether a stale `pd` against a changed Pipedrive API fails legibly.
- Where the generated client sits in this — committed and built in, so a user never runs the generator.
- Whether `AGENTS.md` ships with the tool or lives only in the repo, given it is the canonical documentation a harness reads.

Record as an ADR.
