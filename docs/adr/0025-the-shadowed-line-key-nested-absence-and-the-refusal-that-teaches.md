# ADR-0025: The shadowed line key, nested absence, and the refusal that teaches

Status: accepted, partly superseded
Date: 2026-08-13
Partly superseded by: [ADR-0029](0029-the-record-interior-passes-through.md) §6 — the shadowed-key
refusal below assumed a closed key set, where a reserved field name could only be `pd`'s own missing
rename. Records now carry Pipedrive's key set, so the refusal splits: a rename of `pd`'s that would
shadow or overwrite is still a run-ending `internal`, while a bare reserved name off the wire costs
one record and a `record_rejected` warning.
Partly superseded by: [ADR-0030](0030-the-null-custom-field-drops.md) — the nested-absence section
below repeats ADR-0020 §6's `custom_fields` exemption, and the exemption is withdrawn: a
`null`-valued hash key is dropped. Only the sentence "nothing recurses into it" survives, and it now
means the custom-field **value**'s interior rather than the block.
Deciding ticket: [Remaining live resources and the `get` verb](../../.scratch/pd-impl/issues/07-remaining-resources-and-the-get-verb.md)
Extends: [ADR-0002](0002-output-format.md) §"Every line carries a `type` tag" — the tag is now protected against the record beneath it
Corrects: [ADR-0020](0020-value-formatting-and-absence.md) §7 — `products.prices` is **not** the only nested block, and §6's omission rule is general
Corrects: [ADR-0009](0009-command-surface-and-manifest.md) §6 and [ADR-0017](0017-search-and-list-filtering.md) §2 — `unknown_command` is not a `code`
Extends: [ADR-0006](0006-validation-placement-and-rejection.md) §2, §4 — the by-id envelope, and what a rejected single record means
Extends: [ADR-0006](0006-validation-placement-and-rejection.md) §9 — the hoist gained an `allOf` flatten

## Context

Ticket 05 shipped one resource. Ticket 07 shipped the other four live ones and
the second verb, and the exercise did what a second instance of anything does:
it found the places where a decision taken for `deals` was really a decision
about deals.

Four of the five findings are corrections to accepted ADRs rather than new
ground. They are ratified here on the precedent
[ADR-0023](0023-the-guardedfetch-failure-carrier-and-the-retry-attempt-count.md)
set: where a ticket note and an ADR disagree, the ADR wins, so an invention that
later tickets inherit belongs in an ADR.

## Decision

### 1. A record field never shadows a line key, and `activities.type` is renamed

An activity carries a field called `type`, whose value is `"call"`,
`"meeting"` or `"email"`. A `record` line is flat, and `type` is
[ADR-0002](0002-output-format.md)'s discriminator, so serialising an activity
naively emits `{"type":"call", …}` — a line no reader of the format can
classify, on the one field every consumer dispatches on first.

**The line grammar wins, and the colliding record field is renamed on output.**
`type` is emitted as `activity_type`, in place, so the field keeps its position
in the record. The manifest's per-command field list carries the output name, so
nothing about it is undocumented.

The rival was nesting the record under a key —
`{"type":"record","record_type":"activity","record":{…}}` — which makes a
collision structurally impossible for every resource, now and forever. It was
rejected on blast radius: it changes every `record` line of every resource, all
six normative samples, [ADR-0016](0016-field-projection.md)'s selector grammar
and every consumer already written, to buy safety for one known field. The flat
line is what ADR-0002's examples promise and what an agent's `jq` expects.

The accepted cost is that a *second* collision needs a second rename, and that
`activity_type` is a name Pipedrive does not use. Against that, the rename is one
table entry per resource and is visible in the manifest, while nesting is a
breaking change to the whole format.

**The rename is not trusted to be remembered.** `NdjsonWriter` owns the reserved
set — `type` and `record_type` — and a record field that still collides after the
rename is an `internal` error, not a shipped line. The guard covers both losses:
a field that lands on a reserved name, and a *rename* that lands on a field the
record already has. It exists for the regeneration nobody reads line by line: a
new Pipedrive field named `type` on a sixth resource fails a test rather than
quietly overwriting the discriminator.

**The writer ends that run itself, trailer first.** It writes its own `error`
trailer with the counters it owns, then raises the carrier marked
`trailer_already_written`, and `cli.ts` contributes the exit code and nothing
else. Letting the throw travel bare would have made the top level report
`emitted: 0` over records that were already on stdout — and a bug is precisely
when a counter must not lie. The marker now covers the stderr line as well as
the stdout one, so both refusals that raise it produce exactly one of each.

### 2. The omission rule is recursive, and nested blocks are not rare

[ADR-0020](0020-value-formatting-and-absence.md) §7 stated that `products.prices`
is a nested block and "it is the only one". Reading the four other record
schemas says otherwise: a person carries `emails`, `phones`, `im` and
`postal_address`, an organization carries `address`, an activity carries
`location`, `participants` and `attendees`.

The claim was wrong; the rule it was attached to was right and is now applied as
what it always was — **a general serialisation rule**. §6's "a field with no
value is an absent key" holds at every depth: an absent `person_id` inside an
activity's `participants` entry is an absent key there, exactly as an absent
`direct_cost` is inside a price.

Two boundaries keep it mechanical:

- **Array elements are never dropped, only object keys.** Removing an element
  would renumber its siblings and shorten a list the caller counts, so a `null`
  element keeps its place as `null`.
- **`custom_fields` remains exempt at the top level**, byte-identical with and
  without `--resolve` ([ADR-0008](0008-resolution-mechanics.md) §1). Nothing
  recurses into it.

ADR-0020's Consequences promised that "if a second nested shape ever ships, the
grammar decision is reopened rather than stretched". Eight of them shipped, so it
is reopened here — and closes the same way. [ADR-0016](0016-field-projection.md)
§2 stopped the selector grammar at one level to avoid a permanent dotted-path
surface bought for a single case; eight cases make that argument stronger, not
weaker, because a grammar that reaches inside `participants[0].person_id` has to
answer for indices, missing elements and empty arrays on every resource.
`prices`, `emails` and `participants` are therefore all selectable whole, by bare
top-level name, and no dotted path reaches inside any of them. What died is the
premise that one nested block exists; the decision it was supporting now rests on
its own argument.

### 3. An unrecognised command is `usage`, and it carries a trailer

[ADR-0009](0009-command-surface-and-manifest.md) §6 and
[ADR-0017](0017-search-and-list-filtering.md) §2 both write
`code: "unknown_command"`. [ADR-0001](0001-error-model-and-exit-codes.md) owns
the `code` union, the union is closed, and it does not contain it.
**`unknown_command` is not a `code`.** The response to an unrecognised command
is identical to every other usage error — exit 2, `retry: "never"`, nothing to
wait for — so under ADR-0001's own rule it earns no variant.

Everything else ADR-0009 §6 asked for survives, because none of it was about the
`code`: the message states that `pd` has no write commands **at all**, points at
`pd manifest`, and does **not** claim the only verbs are `list` and `get` —
ADR-0017 §1 added `search`. One probe ends the search.

The refusal is written as a full `error` **trailer**, with `complete: false` and
four zero counters, not as a bare one-line object. A consumer that reads the last
line and two fields must not have to know which failures happen before a stream
starts. `pd auth status` keeps its bare failure, because ADR-0009 §8 puts it
outside the NDJSON grammar altogether.

The refusal distinguishes three mistakes, because telling an agent the wrong one
restarts the search the message exists to end. `pd persons` is not a misspelled
noun — the noun is right and the verb is missing — so it reads *`pd persons`
needs a verb*, and only a noun the table does not hold reads *`pd` has no
command*. Both carry the read-only sentence and the manifest pointer.

The message quotes back only the leading non-flag words of the invocation.
`pd frobnicate --token sekrit` must not put that value into an error object an
agent will log.

### 4. `get` is one page, and a record it cannot read is `invalid_response`

`pd <resource> get <id>` is a generator of exactly one page, consumed by the same
`stream()` loop as a walk. A second consuming loop is a second place the
exactly-one-trailer invariant can be forgotten, and one record needs nothing a
walk does not already do.

The by-id body is a different envelope — `data` is the record, not an array of
them — so it gets its own two-line schema and the same two-stage split
(ADR-0006 §2): the envelope ends the run as `invalid_response`, the record is
judged separately.

**A single record that fails the record schema is `invalid_response`, exit 1,
not a `warning` with `emitted: 0`.** On a list, one bad record out of five
hundred costs the caller one row. On `get`, the rejected record *is* the answer,
and a `summary` reporting nothing emitted would say the record does not exist —
which is what `not_found` means and is not what happened. `not_found` stays with
the 404 the wrapper seam already maps (ADR-0024 §1), so "no such record" and "a
record `pd` cannot read" never share a code.

**One record schema serves both verbs.** Pipedrive titles the by-id response
differently from the list response, so the hoist produces two schemas per
resource; they are identical on all five, and a unit test compares them as JSON
Schema so a regeneration that makes them disagree fails the build rather than
silently validating `get` against the wrong shape.

### 5. The hoist flattens an `allOf` record, and does not preserve it

`pd products list` had no record schema at all: a product is declared as an
`allOf` of `BaseProduct` — itself a nested `allOf` of three objects — and
`PricesArray`, and [ADR-0006](0006-validation-placement-and-rejection.md) §9's
hoist only took a plain `type: object`.

The hoist now collapses a record node's `allOf` chain into one object before
lifting it into `components/schemas`. The merge is into a single object rather
than a preserved intersection for the reason ADR-0006 §2 already recorded about
`zGetDealsResponse`: a `ZodIntersection` supports neither `.pick()` nor
`.omit()`, so a record schema that is one is unrelaxable after the fact and
unusable by ADR-0016's projection later.

Only the record node's own chain is flattened; a property whose *value* is an
`allOf` is left alone, because the generator already handles that shape. Two
members that define the same property differently throw, on the same reasoning
as the existing title-collision guard: a silent merge of two disagreeing shapes
is the failure nobody sees.

This is still ADR-0006 §9 unbroken — the correction is a `parser.patch` against
the input spec, and no generated file is hand-edited.

## Consequences

- **`activity_type` is interface.** It is in the manifest's field list for
  `activities`, and `AGENTS.md` (ticket 19) states the one rename rather than
  leaving an agent to discover that Pipedrive's `type` arrives under a different
  name.
- **The reserved-key guard is a permanent tripwire.** Adding a resource whose
  schema carries `type` or `record_type` fails loudly at the first record, and
  the fix is one table entry.
- **`manifest_version` does not move.** Nothing here removes or repurposes a
  command, a flag or a field; the rename and the recursion specify the first
  surface rather than changing a shipped one.
- **Nested absence compounds with ADR-0020 §6's line-size argument.** A person
  with one email and no label spends one key fewer, on every line of a walk.
- **`pd manifest` is now load-bearing for the refusal**, which points at it.
  Ticket 16 delivers it; until then the message names a command that does not yet
  answer, which is the smaller of the two wrongs against inviting an agent to
  probe for `update`, `delete` and `new` in turn.
- **The four cached resources and `items` are still refused** by the same
  message, because the table has no entry for them yet. Tickets 08 and 14–15
  make them entries, not exceptions.
