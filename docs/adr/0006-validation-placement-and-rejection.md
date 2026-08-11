# ADR-0006: Where validation sits, and what a rejected response does

Status: accepted
Date: 2026-08-11
Deciding ticket: [Where zod validation sits, and what a rejected response does](../../.scratch/pd-cli-design/issues/13-grilling-zod-validation-placement.md)

## Context

Locked point 3 requires zod at every boundary untrusted data enters. Locked point 7 requires one
client module to own every HTTP call. The generated client already supplies TypeScript types, so this
ADR answers what runtime validation adds on top of them, how strict it is, and what a rejection does
to a run.

Four earlier decisions and one research finding constrain the answer and are not reopened:

- [ADR-0002](0002-output-format.md) — NDJSON, every line `type`-tagged, `record` / `warning` /
  `summary` / `error`, exactly one trailer. A rejected record emits a `warning` and does not stop the
  run; the trailer reports how many.
- [ADR-0003](0003-pagination-bounding-and-partiality.md) — `skipped` is on every trailer, and
  `--limit` is counted **after** zod rejection. A run may report `complete: true` with `skipped > 0`.
- [ADR-0004](0004-streaming-and-result-composition.md) — the walk generator owns validation and
  yields only clean pages; `NdjsonWriter` owns stdout, the counters and the single trailer.
- [ADR-0005](0005-cache-design.md) §5 — a cache entry that fails validation is skipped, the resource
  is refetched, and a `warning` is emitted.
- [Hey API research](../../.scratch/pd-cli-design/research/06-hey-api-capabilities.md) — the zod
  plugin emits response schemas; `sdk.validator` is left **off** so a parse failure becomes a typed
  error in the wrapper rather than an untyped one merged with HTTP failures; `parser.patch` corrects
  a wrong spec regeneration-safely and was verified empirically against the real Pipedrive spec.

### A scope decision taken during this ticket

**The v1 API is out of scope except for the `users` resource.** Leads, notes, currencies, activity
types and filters are not exposed by `pd`. The v1 generated client exists solely so that `owner_id`
can be resolved to a person's name, which [ADR-0005](0005-cache-design.md) already reserved a cache
entry for. Ticket 18 is narrowed accordingly.

The consequence for this ADR is direct. Research 04 placed the 40-character custom field hashes as
**top-level keys** on v1 records, and inside a `custom_fields` object on v2 records. With v1 reduced
to `users` — a resource with no custom fields — every record `pd` emits carries its custom fields
inside `custom_fields`, and the strictness question below loses its sharpest edge.

## Decision

### 1. Validation runs in the wrapper, on the response, per record

`sdk.validator` stays `false`. The generated `z*Response` schemas are executed explicitly with
`safeParse` inside the one client module, so the outcome of a parse is a value the wrapper classifies
into `PdError`, rather than a `ZodError` that the generated client merges into the same untyped
`error` field as an HTTP failure and a transport failure.

Nothing validates on the way out. ADR-0002 already fixed that output line shapes are TypeScript types
and are not re-checked; the prototype sample files are the guard against drift.

### 2. The envelope schema and the record schema are separate, and fail differently

ADR-0004 requires a rejected record to be a `warning` plus a `skipped` count rather than the walk's
`Err`. A single `zGetDealsResponse` cannot deliver that: its `data: z.array(zDeal)` fails as a whole,
so one bad record from 2015 would reject all 500 records on its page.

Validation is therefore two-stage:

1. **The envelope**, validated strictly: `success`, `data` as an array of unknown, and
   `additional_data.next_cursor`. A failure here is **structural** and produces
   `Err(invalid_response)` — the walk ends, per ADR-0004's terminal-error contract.
2. **Each element of `data`**, validated individually against the record schema. A failure here is
   **per-record** and produces a `warning` plus `skipped += 1`. The walk continues.

| Failure | Classification | Result |
| --- | --- | --- |
| Body is not JSON | structural | `Err(invalid_response)` |
| `data` absent, or not an array | structural | `Err(invalid_response)` |
| `next_cursor` present with a wrong type | structural | `Err(invalid_response)` |
| An element of `data` fails the record schema | per-record | `warning`, `skipped += 1` |

The Cloudflare block of ADR-0001 is the reason the first row is spelled out: its body is HTML, and it
must never be classified as `invalid_response`. That discrimination happens on status and body shape
in the client module, **before** validation is reached.

**Assumption, stated because it is a dependency and not a decision.** Pipedrive's v2 response bodies
are inline under `paths` rather than in `components/schemas`, so the zod plugin may emit no reusable
`zDeal`. The intended fix is a `parser.patch` that hoists each list response's `data` item schema into
`components/schemas` under a stable name, so the plugin emits it as a definition. Research 06's open
question 4 records that only the whole-spec `patch.input` form was verified. If hoisting proves
impossible, the fallback is a hand-written envelope schema — three fields — with the record schema
taken from the generated definitions. Either way the two-stage split stands; only its plumbing moves.

### 3. Unknown keys are stripped

`z.object` in zod v4 removes unknown keys by default, and that default is accepted deliberately rather
than by omission. `.passthrough()` and `.catchall()` are not used on any record schema.

The consequence is that **a `record` line's shape is a function of `pd`'s version, not of Pipedrive's
release schedule.** A parse that worked yesterday works today. A field Pipedrive adds to a v2 response
without updating its OpenAPI spec does not appear in `pd`'s output until the spec is corrected —
through `parser.patch` if Pipedrive is slow — and `pd` is released.

Passthrough was rejected once the v1 scope decision landed. Its only remaining gain was a field no
command knows, that ticket 15 cannot resolve, and that would simply appear in an agent's context
unannounced. Against that stands stability, which is the more valuable property for the primary
consumer.

**One deliberate exception, which must be protected:** `custom_fields` is
`z.record(z.string(), z.unknown())`. It is an open map by design, and it is where every custom field
on a v2 record lives. No patch may tighten it into a closed object, or stripping would delete exactly
the data ticket 15 exists to resolve.

### 4. A first page with no survivors is `invalid_response`

If the first page's `data` array is **non-empty and no element survives the record schema**, the run
ends with `Err(invalid_response)`, exit 1.

An empty `data` array is an empty success, not a failure. The trigger is zero survivors out of one or
more elements, never zero elements.

The rule separates two different faults:

- **No survivors on the first page** means the schema does not describe this resource at all. It is
  systematic, retrying will not help, and that is precisely the definition ADR-0001 gave the variant.
- **Scattered rejections later** mean the account holds old records. That is survivable and is what
  `skipped` was designed to report.

It also fires at the right moment. The first page is validated before any `record` line is written, so
the `error` trailer's `emitted: 0` is true and nothing has to be retracted — ADR-0004's "already
written stays written" is untouched.

**No later page escalates, and there is no ratio threshold.** A rule of "any wholly rejected page
stops the run" was rejected on the cursor research: v2 cursors behave like keyset markers and walk in
id order, so old records **cluster on the early pages**. A wholly rejected page is therefore expected
in exactly the survivable case, and the rule would kill runs that were fine. A ratio — "more than half
rejected" — was rejected as an arbitrary number nobody can set correctly.

**The hole this leaves, accepted.** Page one yields one survivor and pages two to eighty yield none,
giving `{"complete":true,"emitted":1,"skipped":39999}`. ADR-0002's lazy consumer, reading the last
line and two fields, sees one deal. It is accepted because the alternative is a tunable threshold, and
because such a run is not quiet: it announces itself in the `warning` lines of section 5 and in
`skipped`, which ADR-0003 made mandatory on every trailer.

### 5. `warning` lines are deduplicated by cause; `skipped` counts every record

A run rejecting 40,000 records for one reason has one fact to report, not 40,000. Emitting a line per
record would consume more of the agent's context than the records would have.

A `warning` is emitted on the **first** rejection for a given
`(resource, field path, zod issue code)`. Every later rejection matching an already-reported cause
increments `skipped` only. `skipped` therefore remains an exact count of records dropped, and is the
number a caller reconciles against; the `warning` lines explain *why*, once per why.

**Ownership.** The generator produces a warning per rejected record, as ADR-0004's `Page.warnings`
says. `NdjsonWriter` suppresses the duplicates, because the deduplication key set is run-scoped and
the writer is already the run-scoped owner of stdout and the counters. The generator stays page-local.
This mirrors the split ADR-0004 made for `emitted`.

Distinct causes are bounded by the size of the schema and are few. As a safeguard against a
pathological schema producing unbounded distinct paths, the writer stops emitting after 50 distinct
causes and continues counting; the case is not expected to occur.

### 6. The `warning` line, and its `kind`

ADR-0002 fixed the tag and left the fields open. Two decisions now produce `warning` lines — a
rejected record here, a broken cache entry in ADR-0005 §5 — so the line carries a `kind`
discriminator, and a consumer dispatches on `type` then `kind`.

```json
{"type":"warning","kind":"record_rejected","resource":"deal","id":4711,"path":"person_id","issue":"invalid_type","message":"Expected int, received null."}
{"type":"warning","kind":"cache_entry_skipped","resource":"dealFields","message":"Cache entry could not be parsed; refetching."}
```

`path` is **record-relative** — `person_id`, not `data.7.person_id`. A path containing the element's
index within its page would leak the page, which locked point 5 keeps internal, and would make an
otherwise identical cause look distinct to the deduplication of section 5.

`id` is best-effort. The record failed validation, so its `id` is not trustworthy by assumption; it is
recovered by a separate `safeParse` against `z.object({ id: z.int() })` and the field is **omitted**
when that also fails. It is omitted rather than null, so a consumer never has to distinguish "no id"
from "id was null".

`message` is human prose and, like ADR-0001's `message`, may change freely. `kind`, `resource`,
`path` and `issue` are interface.

### 7. There is no `--no-validate`

The flag is cut. ADR-0004's contract is that a page yielded by the generator is already validated,
deduplicated and bounded; a flag that switches validation off makes that promise conditional, and
every consumer of `Page` would have to ask which mode produced it.

The performance argument does not survive contact with the numbers either. ADR-0002 measured a
40,000-record walk at roughly 20 seconds of wall time, all of it the 80 HTTP requests. A `safeParse`
per record is a small fraction of that, and no flag is worth a hole in the property that stdout only
ever carries records `pd` has checked.

### 8. Cached data is validated on read, with the same record schema

A cache entry is validated in two stages, exactly as a response is:

1. The **cache envelope** — schema version, fetch timestamp, payload — against a hand-written schema
   owned by the wrapper. The file was written by `pd`, so this is a check on `pd`'s own past output
   and on disk corruption.
2. The **payload**, against the *same* record schema the network path uses.

Reusing the schema is the point. A stricter cache schema would let a value be acceptable from
Pipedrive and unacceptable from disk, so `--no-cache` would change what `pd` accepts. A looser one
would make the cache a way to smuggle unvalidated data into stdout.

The outcome of either failure is already fixed by ADR-0005 §5: the entry is ignored, the resource is
fetched fresh, and a `warning` of kind `cache_entry_skipped` is emitted. Section 4's first-page rule
does **not** apply to a cache read — there is no walk, and the refetch is the recovery.

### 9. Schema corrections are made on the spec, never on the generated output

Every correction is a `parser.patch` against the input spec, so types and schemas move together and
nothing under `generated/` is hand-edited.

This is not merely a tidiness rule. Research 06 found that `allOf` becomes a `ZodIntersection`, which
supports neither `.partial()` nor `.pick()` nor `.omit()`, so relaxing a generated schema after the
fact is awkward to the point of impracticality. It also found the concrete lies the patch list starts
from: `person_id` and `org_id` are typed non-nullable but come back `null` for an unlinked deal, and
`additional_data.next_cursor` is typed as a required string but is `null` on the last page of every
list — which would fail the envelope schema of section 2, and therefore section 4, on every complete
walk.

Two mechanical constraints, both verified in research 06 and both easy to get wrong:

- Pipedrive's spec is **OpenAPI 3.0**, where nullability is `nullable: true`. Appending `'null'` to a
  `type` array silently degrades the schema to `z.unknown().nullable()`.
- `propertiesRequiredByDefault: true` flips **presence**, never **null-acceptance**. It is kept,
  because the v2 spec declares almost no `required` arrays and without it every field becomes
  optional; but it is the reason the patch list is needed at all.

The patch list grows from observed responses, not from guesswork. Which fields are marked nullable in
the spec is arbitrary rather than systematic — `close_time` is nullable while `won_time` is not — so
it cannot be reasoned about in advance.

## Consequences

- **ADR-0002 needs a reconciliation.** Its wording "A record rejected by zod … emits a `warning` line"
  is now "emits a `warning` line for the first record with that cause". The tag and the run-continues
  behaviour are unchanged; the count on the `summary` is still exact.
- **ADR-0003 needs a reconciliation.** Its gloss on `skipped` reads "records rejected by zod, each of
  which already emitted its own `warning` line". After the deduplication of section 5 that is no
  longer true: `skipped` counts every rejected record, but the `warning` lines number one per cause.
  The count itself is unchanged and remains exact.
- **ADR-0004 needs a reconciliation.** `Page.warnings` remains one entry per rejected record. The
  suppression happens in `NdjsonWriter`, so `Page` is unchanged and only the writer gained state.
- `kind` on the `warning` line is a new part of the stable output contract. It must be present on
  every `warning`, including the one ADR-0005 already specified.
- A complete list walk cannot work at all until the `next_cursor` nullability patch is in place: the
  last page of every list would fail the envelope schema and end the run as `invalid_response`. This
  is the first entry on the patch list, and it deserves a test.
- Because unknown keys are stripped, `pd` cannot surface a new Pipedrive field without a release. Any
  report of "the field is in the API but not in `pd`" is a patch-list task, not a bug.
- Field projection, still fog on the map, inherits a narrower problem: it can only ever drop fields
  the record schema already admits.
- Ticket 15 inherits that every custom field it resolves arrives inside `custom_fields`, on a v2
  record, since v1 is out of scope apart from `users`.
