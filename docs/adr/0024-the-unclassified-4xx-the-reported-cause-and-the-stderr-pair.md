# ADR-0024: The unclassified 4xx, the reported cause, and the stderr pair

Status: accepted
Date: 2026-08-13
Deciding ticket: [`pd deals list`: the full walk](../../.scratch/pd-impl/issues/05-deals-list-the-full-walk.md)
Extends: [ADR-0001](0001-error-model-and-exit-codes.md) §"Retry policy" — its *other 4xx* row now names a variant
Extends: [ADR-0006](0006-validation-placement-and-rejection.md) §5, §6 — a rejected record has one reported cause, and it is named here
Confirms: [ADR-0006](0006-validation-placement-and-rejection.md) §2 — the hand-written envelope was the fallback that shipped

## Context

Ticket 05 built the tracer bullet: argument parsing, the cursor walk, two-stage
validation, deduplication, `NdjsonWriter`, the error union and the exit codes,
end to end. Almost all of it was a reading of decisions already made. Four things
were not, and each is a choice a later ticket would otherwise make differently.

They are ratified here rather than left in the ticket, on the precedent
[ADR-0023](0023-the-guardedfetch-failure-carrier-and-the-retry-attempt-count.md)
set: where a ticket note and an ADR disagree, the ADR wins, so an invention that
later tickets inherit belongs in an ADR.

## Decision

### 1. An unclassified 4xx is `internal`

`guardedFetch` hands back every status it does not itself own, and the wrapper
maps 401 to `auth`, a JSON 403 to `forbidden` and 404 to `not_found`. ADR-0001's
retry table ends with *other 4xx — no retry* and names no variant for one.

**Any other 4xx is `internal`, exit 1.**

`pd` issues only GETs, and it composes every one of them itself from a generated
client against a spec `pd` also owns. There is no argument the caller can change
that produces a different request, so a 400 or a 422 is not `usage`. It is not
`upstream`, which ADR-0001 defines as 5xx and transport failure, and it is not
`invalid_response`, which is about the shape of a body that arrived. What is
left is exactly ADR-0001's definition of `internal`: a programmer error that
escaped, whose caller response is *file a bug*.

The status rides in `details`, which ADR-0001 already declares unstable and
un-branchable, so a bug report carries the number without promising it.

### 2. The reported cause of a rejected record is its first zod issue

ADR-0006 §5 keys warning deduplication on `(resource, field path, zod issue
code)` and §6 gives the `warning` line one `path` and one `issue`. A record that
fails three fields has three issues and one line, so which issue is *the* cause
had to be decided.

**The first issue in zod's list is the reported cause.** A record with three bad
fields has one reason a caller will act on — the schema does not describe this
record — and reporting all three would enter the same record under three
deduplication keys, making one fault look like three.

**A failure of the record as a whole has `path: ""`.** An element of `data` that
is not an object at all fails at the root, where zod's path is empty. `""` is
the honest rendering: the field path is the empty path. It is not omitted,
because ADR-0006 §6 makes `path` interface and a field that comes and goes is a
field a consumer must test for — unlike `id`, which is omitted precisely because
its absence is the information.

### 3. Both of ADR-0001's channels are written by `NdjsonWriter`

ADR-0001 requires the machine-readable error object on stdout **and** a
human-readable one-line summary of the same error on stderr. Those are two
writes, and any caller that performs one and forgets the other produces a run
that is silent in one channel.

`NdjsonWriter.error()` writes both. It is already the only thing that writes to
stdout (ADR-0004), so making it the only thing that writes the paired stderr line
costs nothing and removes the way the pair comes apart. The stderr sink is a
constructor parameter beside the stdout sink, on the seam reasoning of ADR-0019
§4, and is not a test-only flag of the kind ADR-0019 §5 forbids.

This does **not** make the writer the owner of stderr in general. ADR-0015's run
diagnostics and ADR-0003's every-10,000-records notice are ticket 17's, and they
are a different channel of a different thing.

**The writer is also the second raiser of ADR-0023's failure carrier.** Its
refusal of a second trailer is a `void` method with no `Result` channel, which
is the same argument ADR-0023 made for `guardedFetch`, so the refusal throws a
`PdFailure` and `src/cli.ts` converts it back. The carrier is therefore no longer
confined to the HTTP seam, and ADR-0023's wording to that effect is superseded by
this paragraph. Its **shape** is unchanged: one class, holding an ADR-0001 error
object, converted back at a boundary that is named.

The refusal's error carries `details.trailer_already_written`, and `cli.ts` reads
it for one purpose: to write the human stderr line and **not** a second `error`
line to stdout. Writing one would be the guard committing the violation it
exists to catch.

### 4. The envelope schema is hand-written, and that was the sanctioned fallback

ADR-0006 §2 recorded an assumption with two outcomes: hoist each list response's
`data` item schema into `components/schemas` so the zod plugin emits a reusable
record schema, or fall back to a hand-written envelope of three fields.

**Both happened, and that is the intended shape.** The hoist works and produces
`zGetDealsItem`, which is the record schema. The generated *envelope*,
`zGetDealsResponse`, is nevertheless unusable: it is `z.object({success}).and(…)`
around `data: z.array(zGetDealsItem)`, so it fails as a whole and one bad record
from 2015 would reject all 500 records on its page — the exact failure ADR-0006
§2 split validation in two to prevent. Being a `ZodIntersection` it also supports
neither `.pick()` nor `.omit()` (ADR-0006 §9), so it cannot be relaxed after the
fact.

`ListEnvelope` is therefore written by hand, once, and shared by every list
endpoint: the v2 list envelope is the same three fields on all of them.

**An absent, `null` or empty `next_cursor`, and an absent `additional_data`
block, all mean the walk is over.** Only a `next_cursor` *present with a wrong
type* is structural, which is the row ADR-0006 §2 spells out. Treating an absent
block as structural would make `pd` depend on a spec detail it has already caught
lying about this very field.

## Consequences

- **Ticket 07 inherits the status mapping.** The eight remaining resources add a
  record schema and a table row, not an error classification.
- **`ListEnvelope` is the contract for every list endpoint**, including the
  search endpoints of ticket 14 if their envelope proves identical. If one is
  not, that is a second envelope schema, not a loosening of this one.
- **The v2 record schemas are stricter than the live API.** `won_time`,
  `lost_time` and `expected_close_date` are typed non-nullable and, under
  `propertiesRequiredByDefault: true`, required — while an open deal has none of
  them. Against a real account that is a wholly rejected first page and therefore
  `invalid_response` under ADR-0006 §4. This is precisely the patch-list task
  ADR-0006 §9 describes, it must be driven by observed responses rather than
  guesswork, and it is the first thing the live suite of ADR-0019 §9 will find.
  It is named here so that the finding is recognised as expected work rather than
  as a bug in the walk, and it is filed as ticket 21.
- **`collect` ships unused**, as ADR-0004 said it would. It has unit tests
  because a path with no caller and no test is a path that is wrong by the time
  it gets one; any command that adopts it is marked `delivery: "collects"` in the
  manifest.
- **The prototype samples are now generated by driving the writer** rather than
  transcribed by hand, and a test compares the committed files to that output
  byte for byte. ADR-0002 made those files the only guard against format drift;
  this is what makes the guard mechanical.
