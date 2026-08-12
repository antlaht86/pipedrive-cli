# Field projection: shrinking output against an agent's context budget

Type: grilling
Status: open

Blocked by: 15

## Question

A 40,000-record walk emits every field of every record, and `--resolve` now roughly doubles that.
An agent that wanted three fields pays for forty in its context window. Does `pd` offer a projection,
and what exactly does it project?

- Does a `--fields` style flag exist at all, or is trimming the caller's job? The counter-argument is
  real: `jq` exists, and a flag that duplicates it earns its place only by saving the tokens that
  never reach the agent in the first place — which it does, because the caller reads `pd`'s stdout,
  not Pipedrive's.
- What the selector language is. Bare top-level names only, or dotted paths into `custom_fields`?
  A hash is a legal-looking key but not a legal-looking identifier.
- How a projection names a custom field. By hash, by display name, or both? [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md)
  chose hash keys precisely because display names can collide — a projection that accepts names
  inherits that collision, and a projection that accepts only hashes is unusable by hand.
- What a projection does to `custom_fields_resolved`. Does selecting a hash bring its resolved entry
  along automatically, does the resolved block need selecting separately, or is the block exempt from
  projection entirely?
- What it does to the sibling fields of [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) §3.
  Selecting `org_id` — does `org_name` come with it? They are one fact in two keys.
- Whether a projection can drop a whole record, not merely fields. [ADR-0003](../../../docs/adr/0003-pagination-bounding-and-partiality.md)
  makes `emitted` count `record` lines, so a field-dropping projection leaves the count untouched;
  a record-dropping one would be a third subtractive filter alongside `skipped` and `duplicates` and
  would need its own trailer field. Ruling record-dropping out keeps the trailer as it is.
- Whether a selected field that does not exist is an error (exit 2, usage) or a silent omission.
  Silent omission means a typo produces plausible-looking output with a field quietly missing.
- Whether projection interacts with the upstream `include_fields` query parameter that v2 offers on
  deals, persons, organizations and activities — pushing the trim to Pipedrive would shrink the
  response too, but it is per-endpoint and would make `pd`'s behaviour depend on which endpoint is
  being read.
- What projection does under `--pretty`, where the column set is already unstable per [ADR-0002](../../../docs/adr/0002-output-format.md).

Record as an ADR.

## Context added while resolving other tickets

- [ADR-0003](../../../docs/adr/0003-pagination-bounding-and-partiality.md): `emitted` counts `record`
  lines. A projection that only drops fields does not touch it.
- [ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md): unknown keys are stripped,
  so a projection can only ever select from fields `pd`'s own record schema already admits. The set of
  selectable names is therefore knowable from `pd`'s version alone, not from Pipedrive's.
- [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) graduated this ticket out of the fog and
  fixes three things it must work with: `custom_fields_resolved` is a parallel hash-keyed block,
  resolution adds seven sibling `*_name` fields beside their ids, and `custom_fields` is byte-identical
  with and without `--resolve`.
