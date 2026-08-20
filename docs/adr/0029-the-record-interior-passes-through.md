# ADR-0029: The record interior passes through unvalidated

Status: accepted
Date: 2026-08-17
Supersedes: [ADR-0006](0006-validation-placement-and-rejection.md) §3, and the record stage of §2,
§4, §8 and §9
Deciding ticket: [21 — The nullability patch list](../../.scratch/pd-impl/issues/21-the-nullability-patch-list.md)

## Context

ADR-0006 §2 split validation in two: the **envelope**, validated strictly, and the **record**,
validated per element against a schema generated from Pipedrive's OpenAPI document. Ticket 05 then
found what the record stage costs.

The v2 spec declares almost no `required` arrays, so generation runs with
`propertiesRequiredByDefault: true`. Every declared field therefore becomes required. Pipedrive does
not send every declared field: an **open** deal has no `won_time`, no `lost_time` and no
`expected_close_date`, all three of which `zGetDealsItem` types as required. A page of open deals is
a page with zero survivors, and ADR-0006 §4 turns a first page with zero survivors into
`invalid_response`, exit 1.

`pd deals list` against a real account therefore emits nothing at all. The rule is doing exactly what
ADR-0006 §4 says it should — *the schema does not describe this resource* — and it is right. The
schema does not.

ADR-0006 §9 fixed the repair: grow a patch list from observed responses. Ticket 21 costed that. It
needs a recorded response per resource for nine resources, from a live account, and ADR-0019 §9's
recorder writes those responses into the repository as versioned fixtures. Two further faults ride
along: absence and nullability are different repairs and only an observed response tells which a
field needs, and the spec's `default` values materialise data Pipedrive never sent, which contradicts
ADR-0020 §6.

The project's owner declined the recording. Real CRM data is not to be committed to this repository,
under any of the arrangements ADR-0021 §9 considered. That removes the only evidence ADR-0006 §9
permits, and reading the spec instead is the one method that ADR explicitly forbids.

So the patch list cannot be built. The question this ADR answers is what should replace it.

## Decision

### 1. `pd` validates what it reads, and passes through what it only emits

The dividing line is **use**, not origin.

Where `pd`'s own logic depends on a value, that value is validated, because a wrong value there makes
`pd` misbehave: the walk needs a cursor, deduplication needs an identity, resolution needs an id and
a name. Where a value is only copied from the response to stdout, it is not validated, because there
is nothing for `pd` to be wrong about. A deal's `won_time` is carried, never read.

This is a narrowing of ADR-0006 §1, not a reversal of it. Locked point 3 requires zod at every
boundary untrusted data enters; the boundary is now defined as *the values `pd` acts on* rather than
*every key on the wire*.

**Amendment (2026-08-20, ticket 27): `pd` reads inside a `users` record's `access`.** It derives
`is_global_admin` and `is_deal_admin` from it (ADR-0007 §3), so by this ADR's own rule of **use**
that value is now read and is validated — leniently, one entry at a time: `app` as a string, `admin`
as a boolean, and no enum over either. An entry that does not read that way is skipped, not
rejected, because a `users` record that fails the gate is a name lost from `--resolve` as well as
from stdout (ADR-0007 §5).

`access` itself is still emitted exactly as it arrived, and the lenient read never rewrites it. The
two rules therefore both hold on the one value: the derivation validates what it reads, and the
passthrough emits what `pd` only copies.

### 2. What stays validated

| Subject | Schema | Why |
| --- | --- | --- |
| The list envelope | `ListEnvelope`, hand-written | The walk cannot survive being wrong about `data` or `next_cursor` |
| The by-id envelope | `RecordEnvelope`, hand-written | Same, for the single-record shape |
| The cache envelope | Hand-written, ADR-0005 | `pd`'s own past output, plus disk corruption |
| A record's identity | `IdentifiedRecord` / a source's `key` | Deduplication and `get` both key on it |
| A search hit | The hit schemas of ADR-0017, hand-written | `pd` **reshapes** these: it flattens `item`, renames `owner` to `owner_id`, and splits objects into `*_id` / `*_name` pairs |
| A `users` record | `UserRecord`, hand-written, ADR-0007 §3 | `pd` reads `id` and `name` to resolve owners |
| A `users` record's `access` entries | `{ app: string, admin: boolean }`, hand-written, leniently, per entry | `pd` derives `is_global_admin` and `is_deal_admin` from them (ticket 27) |
| Resolution inputs | `NamedRecord`, `ResolutionField`, hand-written | `--resolve` reads ids, names, field codes and option labels |

Every schema in that table is **hand-written by `pd` from an observed response**. Not one is
generated from Pipedrive's OpenAPI document. That is the property this ADR is really buying: the
schemas that remain describe things somebody saw, which is the standard ADR-0006 §9 set and could not
meet for the generated ones.

### 3. What stops being validated

The generated record schemas — `zGetDealsItem` and its four siblings, `zGetPipelinesItem`,
`zGetStagesItem`, and the five `*Fields` element schemas — stop gating records. The element of `data`
is emitted **as it arrived**.

They are still imported, and still serve one purpose: their `shape` is the **field vocabulary**. It
is what `Resource.fields` and `CachedSource.fields` hold, and therefore what `--fields` validates
against offline (ADR-0016) and what the manifest publishes as each command's selectable list
(ADR-0009). A generated schema is a good enough description of what a resource *usually* has to serve
as a vocabulary, while being a bad description of what it *always* has — which is precisely the
distinction that broke the gate.

### 4. Records are not run through zod at all

The passthrough is not `z.looseObject` or `.passthrough()`. A zod object parse reconstructs the value,
and reconstruction can reorder keys — shape order first, unknown keys after. ADR-0002 makes the key
order on a `record` line the key order on the wire, and `walk.ts` states it.

`IdentifiedRecord` is therefore a `z.custom`, which runs a predicate and returns **the same object
reference**. Nothing is copied, nothing is reordered, nothing is dropped, and no `default` fires.

### 5. What a rejected record now means

The machinery of ADR-0006 §5 and §6 stays exactly as it is — `record_rejected`, deduplication by
cause, `skipped`, the best-effort `id`, and §4's zero-survivors rule. Only the trigger narrows.

A record is now rejected when it is **not an object with a usable identity**: not an object, or no
integer `id` (no non-empty string `field_code`, for the `fields` sources). Nothing else can reject
one.

The narrowed §4 keeps its meaning rather than losing it. A first page where no element has an id is
still systematic, still unretryable, and still means `pd` cannot read this resource — it is simply a
much rarer thing to be true.

### 6. Unknown keys are emitted, reversing ADR-0006 §3

ADR-0006 §3 chose stripping deliberately, and named the property it bought: *a `record` line's shape
is a function of `pd`'s version, not of Pipedrive's release schedule.* That property is now gone, and
its loss is the real price of this ADR.

A field Pipedrive adds to a v2 response appears in `pd`'s output the day Pipedrive ships it, with no
release and no patch. The gain is that `pd` no longer hides data it was given, and that the "the
field is in the API but not in `pd`" report of ADR-0006's consequences stops existing.

The asymmetry this creates is worth stating plainly, because it will surprise someone:

**A key can be emitted and yet not be `--fields`-selectable.** Output is whatever Pipedrive sent; the
`--fields` vocabulary is whatever the spec declares. A field newer than the vendored spec appears in
full output and is rejected offline, exit 2, by `--fields`. Regenerating the client fixes it. This is
accepted rather than repaired: the alternative is a vocabulary read from the first response, which
would make an offline refusal depend on a network call.

**A reserved name off the wire costs one record, not the run.** ADR-0025 §1 refuses to emit a record
carrying a field that would shadow `type` or `record_type`, because the line would be
unclassifiable — and it ends the run, on the reasoning that a closed key set makes such a field
`pd`'s own bug, a resource missing a rename. Under §3 the key set is Pipedrive's, so a field it
happens to name `type` would kill every run of a resource with no rename for it. That is the exact
fragility this ADR exists to remove.

The refusal therefore splits by fault. `pd`'s rename table landing on a reserved name, or on a field
the record already has, stays a run-ending `internal` — that is still a bug in `pd`. A bare reserved
name that arrived on the wire becomes one `record_rejected` warning with `issue: "shadowed"`, one
`skipped`, and a walk that continues. No new `kind` is minted: the record was rejected, and
deduplication by cause (ADR-0006 §5) then reports one warning however many records share the field.

Unlike the walk's rejections this one is raised where the record is written, so its warning sits
between `record` lines rather than ahead of them. ADR-0004's "every warning precedes every record" was
a statement about the collected path; what ADR-0002 promises is that both precede the trailer, and
they do.

### 7. Three faults close as a side effect

- **The nullability patch list is unnecessary.** No interior is parsed, so no interior can be wrong
  about nullability. Ticket 21 closes as superseded rather than done.
- **Absence versus nullability disappears as a question.** Nothing parses the interior, so nothing
  turns an absent key into a `null` or a `null` into a default. What ADR-0020 §6 does with the two
  afterwards is unchanged and is not this ADR's business: the writer omits both, so a caller still
  cannot tell an absent field from a null one — it simply is no longer `pd`'s *schema* that decides
  which arrives.
- **`.default()` no longer materialises data.** `zGetProductsItem` types `tax` as
  `z.number().default(0)`, so an absent `tax` used to be emitted as `0` and a caller could not tell it
  from a tax Pipedrive reported. Nothing parses the interior now, so nothing invents a value.

### 8. Key order becomes the wire's, and ADR-0016 §9 survives it

Before this ADR a `record` line's keys came out in the generated schema's order, because that is what
a zod object parse reconstructs. They now come out in the order Pipedrive sent them.

ADR-0016 §9 called that order "`pd`'s schema order" and promised a property on top of it: two callers
selecting the same fields in different orders get byte-identical records. The property holds
unchanged, because projection iterates the *record* rather than the selectors — only the sentence
naming its source is now wrong, and the promise it was making is the part that mattered. A test in
`test/field-projection.test.ts` pins it.

In practice the two orders coincide, since Pipedrive serialises a record in much the order its own
spec declares. Nothing should depend on either: ADR-0002 makes a `record` line a JSON object, and the
key order of a JSON object is not a contract a reader may lean on.

### 9. `parser.patch` stays, and `openapi-ts.config.ts` is untouched

The existing patches are unchanged. `next_cursor` matters to the hand-written envelope's source of
truth, the `allOf` hoist is what makes `zGetProductsItem` exist as a vocabulary at all, and the three
entries in `NULLABLE_IN_PRACTICE` are harmless. The mechanism ADR-0006 §9 established — corrections on
the spec, never on generated output — is still the rule for anything that does get patched.

What is deleted is the **obligation** to grow that list from live recordings.

## Consequences

- **ADR-0006 keeps §1's placement, §5's deduplication, §6's line shape and §7's refusal of a
  `--no-validate` flag.** Its §3 is reversed, and its §2, §4, §8 and §9 apply to a much smaller
  subject. The two-stage split itself survives; the second stage simply got very small.
- **ADR-0019 §9's live recorder loses its reason to exist.** It was built to feed the patch list.
  Nothing else needs it, and no fixture it would write is now wanted. It stays in the repository,
  hand-invoked, as a drift detector — which is what ADR-0019 §9 said its output was for — but no
  ticket depends on it.
- ~~**`fixtures/live/responses.json` stays empty**, and the ADR-0019 §10 gate that greps the fixture
  tree for credential-shaped strings stays. A gate over an empty tree is cheap, and the tree is empty
  by decision rather than by accident.~~ Superseded by
  [ADR-0032](0032-the-canary-is-the-whole-binary-exclusion-gate.md): the file and the tree are
  deleted, and the credential scan goes with them. What survives is the binary-exclusion tripwire,
  armed from the canary constant rather than from the file.
- **`pd` becomes more robust to Pipedrive changing its API and less able to describe it.** The two
  move together and cannot be separated: a schema strict enough to document a resource is strict
  enough to reject one.
- **The manifest's selectable field lists are now a floor, not a ceiling.** A consumer that wants to
  know what a record actually holds must read a record.
- **Test fixtures stop needing every declared key.** `test/support/deals.ts` documents that it carries
  every key `zGetDealsItem` declares, including a `won_time` on an open deal, which was invented to
  satisfy a gate that no longer exists.
