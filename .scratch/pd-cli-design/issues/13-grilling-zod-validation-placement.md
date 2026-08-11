# Where zod validation sits, and what a rejected response does

Type: grilling
Status: resolved

Blocked by: 06, 09

## Question

The generated client already gives types. Where does runtime validation add value, and how strict is it?

- Placement: inside the single client module so nothing escapes unvalidated, or at the command layer, or both. Locked point 7 argues for the client module.
- Generated schemas versus hand-written ones. Locked point 3 says prefer generated. Where is the spec known to be wrong or too loose enough to justify a hand-written override, and how is an override expressed so regeneration does not clobber it?
- The strictness question: does validation reject unknown fields, or pass them through? A CRM with custom fields returns keys the spec never described, so stripping unknown keys would delete the very data ticket 15 is about.
- What happens when a legacy record fails validation. Hard failure for the whole run, hard failure for that record only, or pass through with a warning on stderr. Argue it: a hard failure makes one bad record from 2015 break a report; a pass-through makes the type system a polite fiction.
- If a record can be dropped or degraded, how the caller learns — a count on the partiality marker, a per-record marker in the output, or a stderr warning only. An agent does not read stderr by default.
- Whether validation cost matters on a 40,000-record walk, and whether it can be skipped by a flag. If it can, is the flag a hole in the safety story?
- What validates cached data read back off disk, and whether that is the same schema or a stricter one.

Record as an ADR.

## Context added while resolving other tickets

- [ADR-0004](../../../docs/adr/0004-streaming-and-result-composition.md) fixed **who runs** per-record
  validation: the walk generator, which yields only validated, deduplicated pages. That settles the
  last two bullets of the placement question by derivation — a rejected record can never be the
  walk's `Err`, it is a `warning` line plus a `skipped` count on the trailer, and the caller learns
  through stdout rather than stderr. This ticket still owns *which schema* runs there, how strict it
  is, how a hand-written override survives regeneration, and what validates cached data.
- A `--no-validate` style flag would have to be argued against ADR-0004's page atomicity as well: the
  generator's contract is that a yielded page is already clean.

## Answer

Recorded as [ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md).

**A scope decision was taken during this ticket and belongs to the map, not to this ADR alone: the v1
API is out of scope except for the `users` resource.** Leads, notes, currencies, activity types and
filters are not exposed. That removes the sharpest half of the strictness question, because the
top-level 40-character custom field hashes lived on v1 records only.

- **Placement.** `sdk.validator` stays off; the generated `z*Response` schemas run explicitly with
  `safeParse` in the one client module, so a parse failure becomes a typed error instead of being
  merged into the generated client's untyped `error` field alongside HTTP and transport failures.
- **Two-stage split.** The envelope is validated strictly and its failure is structural —
  `Err(invalid_response)`, the walk ends. Each element of `data` is validated individually and its
  failure is per-record — a `warning` plus `skipped += 1`, the walk continues. A single
  `zGetDealsResponse` could not deliver ADR-0004's per-record skip, because `data: z.array(zDeal)`
  fails as a whole.
- **Strictness: strip.** zod v4's default is accepted deliberately; no `.passthrough()`, no
  `.catchall()`. A `record` line's shape is a function of `pd`'s version, not of Pipedrive's release
  schedule. The one protected exception is `custom_fields`, an open `z.record` by design.
- **Mass rejection.** A first page whose `data` is non-empty and yields **no** survivors ends the run
  as `invalid_response`. No later page escalates and there is no ratio threshold — keyset cursors walk
  in id order, so old records cluster early and a wholly rejected page is expected in the survivable
  case.
- **Warning flood.** A `warning` is emitted once per distinct
  `(resource, field path, zod issue code)`; `skipped` still counts every record. `NdjsonWriter` owns
  the suppression, `Page.warnings` is unchanged. The line gains a `kind` discriminator, shared with
  ADR-0005's cache warning.
- **No `--no-validate`.** It would make ADR-0004's clean-page promise conditional, and the cost it
  would save is a small fraction of the 20 s of HTTP the same walk already pays.
- **Cached data** is validated with the *same* record schema as the network path, behind a
  wrapper-owned cache envelope. A stricter cache schema would make `--no-cache` change what `pd`
  accepts.
- **Overrides** are `parser.patch` against the input spec, never edits to `generated/`. The patch list
  starts with `next_cursor` nullability, without which the last page of every list fails.
