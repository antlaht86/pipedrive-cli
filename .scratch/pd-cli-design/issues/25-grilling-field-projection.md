# Field projection: shrinking output against an agent's context budget

Type: grilling
Status: resolved

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

- **[ADR-0015](../../../docs/adr/0015-stderr-and-run-diagnostics.md) §6 touches whatever query
  parameter this ticket adds.** `--verbose` logs request URLs, and query values print only for an
  allowlist (`limit`, `cursor`, `sort_by`, `sort_direction`, `include_option_labels`, `ids`); anything
  else is `[redacted]`. A projection field list is structural rather than company data, so it is
  arguably allowlist-eligible in a way a search term is not — this ticket's call, and the only reason
  to make it is debuggability of the projection itself.

## Answer

Recorded as [ADR-0016](../../../docs/adr/0016-field-projection.md).

**`--fields` exists**, comma-separated, the ninth global flag, with `id` always emitted regardless. The `jq` counter-argument fails on a specific point: the agent does not read Pipedrive's response, it reads `pd`'s stdout, and a harness capturing stdout has already spent the tokens before any downstream filter could run.

**Grammar is two forms**: bare top-level names, and `custom_fields.<hash>`. No display names — ADR-0008 chose hashes because names collide, and a projection accepting names inherits the collision at the worst moment. `pd fields list --entity deals` is the lookup, at zero requests warm.

**One rule covers both of ADR-0008's second-key problems**: a resolution artifact rides with its raw field and is never selectable alone. Selecting a hash brings its `custom_fields_resolved` entry; selecting `org_id` brings `org_name`. The invariant bought is that **the legal selector set does not depend on `--resolve`** — the rejected alternative lets `--fields org_name` without `--resolve` return a record with nothing in it.

**Projection removes fields, never records.** The trailer is untouched and a record whose every selected field is absent still emits with just its id. Filtering is ticket 26's.

**Unknown name is exit 2 before any request** — possible offline because ADR-0006 makes the schema `pd`'s own — while an unmatched hash is one deduplicated `warning`, `kind: "unmatched_field_selector"`. A wrong name is always a mistake; a hash matching nothing might be a field nobody filled in.

**The ticket's push-down premise was wrong and the live spec inverted it.** `include_fields` is *additive* — "additional data namespaces", enum-constrained — and cannot trim anything, so it is never sent and its namespaces (`notes_count`, `products_count`, mail timestamps) are simply outside `pd`'s schema. The real subtractive parameter is `custom_fields`, max 15 keys, verified on eight operations covering deals, persons, organizations and products. `pd` pushes down when every condition holds and trims locally otherwise, which is contract-invisible because **output is byte-identical either way** — the per-endpoint availability the ticket feared never reaches the caller.

**Manifest gains a per-command selectable-field list.** Without it the flag's primary consumer must run the command unprojected to learn the field names, spending exactly the context the flag exists to save. Hashes stay out (per-account, `pd fields list` serves them). Additive, so `manifest_version` does not move.

**Key order is `pd`'s schema order in machine mode** so two callers selecting the same fields get identical bytes, and **selector order under `--pretty`**, which is already unstable. **ADR-0015 §6's allowlist gains `custom_fields`** — structural, and logging it is how "why is my field missing" gets answered.
