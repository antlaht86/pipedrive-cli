# Assemble the locked spec

Type: task
Status: resolved

Blocked by: 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29

## Question

Every decision is made and recorded on its own ticket. Consolidate them into the artifact this map exists to produce.

- Write `.scratch/pd-cli-design/spec.md`: the destination artifact, complete enough that a fresh session can build `pd` from it without reopening a decision.
- Confirm every decision ticket produced its ADR under `docs/adr/`, and that no ADR contradicts another.
- Record the domain vocabulary in `CONTEXT.md` — the terms this design settled on, so implementation does not drift to synonyms.
- Draft `AGENTS.md` as the canonical documentation file, with the harness-specific pointer files it requires.
- Re-read the **Not yet specified** section of the map. Anything still there is either a real gap the spec must name as open, or fog that was quietly resolved along the way. Say which.
- Confirm the read-only property and the shared-budget property are each traceable to specific mechanisms in the spec, not merely asserted in its introduction.

## Context added while resolving other tickets

- [ADR-0003](../../../docs/adr/0003-pagination-bounding-and-partiality.md) added `skipped` and
  `duplicates` to the trailer line. The sample files under `prototypes/10-output-format/` predate
  them and no longer match the normative shape. Under ADR-0002 those samples are the only guard
  against format drift, so regenerate them as part of assembling the spec.

## Answer

The locked design is assembled in [`../spec.md`](../spec.md), its decisions are recorded in
`docs/adr/`, and its ubiquitous language is in `CONTEXT.md`. `AGENTS.md` is the canonical
agent-facing contract and is embedded in the compiled binary. Implementation tickets 19 and 20 now
assert that documentation and the release artifact itself: exact embedded docs, version agreement,
fixture exclusion, CWD `.env` refusal, the read-only gates, stderr redaction and fixture credential
stripping. The map's Not yet specified section is empty, and both safety properties trace to named
mechanisms rather than remaining introductory claims.
