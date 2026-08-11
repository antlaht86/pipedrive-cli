# Where zod validation sits, and what a rejected response does

Type: grilling
Status: open

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
