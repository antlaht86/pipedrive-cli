# ADR-0030: The null custom field drops, at the hash and no deeper

Status: accepted
Date: 2026-08-17
Supersedes: [ADR-0020](0020-value-formatting-and-absence.md) §6's `custom_fields` exemption
Confirms: [ADR-0008](0008-resolution-mechanics.md) §1 — the block stays byte-identical with and
without `--resolve`, because the drop happens in both modes
Deciding ticket: [22 — The null custom field drop](../../.scratch/pd-impl/issues/22-the-null-custom-field-drop.md)

## Context

[ADR-0020](0020-value-formatting-and-absence.md) §6 made absence mean *omit the key*, recursively,
everywhere in a record — and then exempted one block by name. A hash key Pipedrive sends inside
`custom_fields` with a `null` value stayed, on two stated grounds: ADR-0008 §1 requires the block
byte-identical with and without `--resolve`, and the block is passthrough data rather than `pd`
schema.

The exemption was never measured. One run against a real account, `pd deals list --limit 1
--fields custom_fields`, settles it:

| | |
| --- | --- |
| hash keys in the block | 87 |
| `null` | **83** |
| filled | 4 (`35`, `[10,11]`, `"2021-11-04"`, `"2021-11-09"`) |
| record as emitted | 4259 bytes |
| record with nulls dropped | 275 bytes |

**93.5% of the record says nothing.** The account has 87 deal custom fields defined and this deal
fills four of them, which is the ordinary shape of a Pipedrive account rather than a pathological
one: fields accumulate per company, and each deal uses the handful its pipeline needs. Over a
40,000-record walk the exemption spends roughly 170 MB on `null`.

ADR-0020 §6's own justification — "a null-emitting record spends eight to ten keys per line saying
nothing" — applies an order of magnitude harder inside the block it exempted than outside it.

The first stated ground does not survive inspection: dropping the nulls in **both** modes leaves
`custom_fields` byte-identical between them, which is all ADR-0008 §1 asks. Only the second ground
is real, and it decides the *depth* of the drop rather than whether it happens.

## Decision

### 1. A `null`-valued hash key is dropped from `custom_fields`

The ADR-0020 §6 exemption is withdrawn. `custom_fields` obeys the same absence rule as the rest of
the record: `null` and absent are absent, and an empty array, an empty string and `0` are values and
are emitted.

The information a dropped key carried — *this field exists on this account* — is not lost, it moves
to where it was already served better. `pd fields list` is the account's field schema, it is a
cached resource, and it answers once per run rather than once per record.

### 2. The drop stops at the hash; the value interior passes through

A custom-field value is not always a scalar: monetary is `{value, currency}`, daterange adds
`until`, timerange has its own object, an address-type field has a dozen subkeys of which three or
four are typically filled.

`pd` does not reach inside any of them. `hash: null` disappears; `hash: {"value":500,"currency":null}`
is emitted exactly as received. A value object that would empty out entirely is not a case that
arises from this rule, because the rule never enters the object.

The reason is [ADR-0029](0029-the-record-interior-passes-through.md): a record's interior passes
through unread, and a custom-field value's shape is Pipedrive's rather than `pd`'s. Dropping a key
from inside that shape is *interpreting* it, and it risks removing a key a consumer treats as always
present — a monetary value with no `currency` is a worse output than a monetary value with a null
one.

**The accepted cost is one visible asymmetry.** A person's native `postal_address` block is walked by
ADR-0020 §6's recursion and loses its null subkeys today; the same address shape as a *custom* field
keeps them. Identical data, two outputs, and the difference is which side of Pipedrive's field model
the field happens to live on. A consumer reading addresses handles both. Accepted, because the
alternative buys one shape a permanent licence to interpret every shape.

### 3. An emptied block is `{}`

When every hash drops, `custom_fields` is emitted as `{}` — ADR-0020 §6 already distinguished a
block from a value, and that distinction is unchanged. `custom_fields` never disappears from a record
that was not projected to exclude it.

### 4. `custom_fields_resolved` follows the raw block

Only a surviving hash gets a resolution artifact. A dropped hash appears in neither block.

[ADR-0008](0008-resolution-mechanics.md) makes resolution an **additive decoration of a raw value**;
with no value there is nothing to decorate. The alternative — keeping every hash in the resolved
block as a display-name index — would turn `--resolve` into a field-schema lookup, which is
`pd fields list`'s job, and would hand back under a second name every byte §1 just saved.

### 5. `unmatched_field_selector` fires for a hash that is null everywhere

[ADR-0016](0016-field-projection.md) §6 warns once, deduplicated, when a selected hash matches zero
records across the whole run. "Matched" now means *survived into the output at least once*, so
`--fields custom_fields.<hash>` on a field nobody has filled ends the run with that warning, and the
records emit `custom_fields: {}` — ADR-0016 §5 keeps the record itself.

This is the reading ADR-0016 §6 already wrote down: it justified warning rather than erroring with
"a hash that matched nothing might just be a field nobody filled in". The empty-field case was the
warning's case from the start. The alternative would make `pd` remember which keys existed before
the drop, and the only use for that memory is the warning's wording.

The warning therefore does not distinguish a typo from an empty field. Already accepted in
ADR-0016 §6.

### 6. No escape hatch, and the bump is MINOR

There is no `--include-empty`. [ADR-0026](0026-the-guards-scope-and-the-size-warnings-one-suppressor.md)
§2 settled the general form of this — "a threshold with a knob is a switch nobody ever turns" — and a
flag whose only purpose is to read the account's field schema out of record lines competes with a
command that reads it directly and once.

The release is a **MINOR**, `1.1.0`, and `manifest_version` does not move. Nothing in
[ADR-0021](0021-distribution-build-from-source.md)'s MAJOR row changes: no line shape, no `type` tag,
no trailer field, no exit code, no error `code`, no command. Hash keys are per-account passthrough
data and were never in `pd`'s field vocabulary ([ADR-0029](0029-the-record-interior-passes-through.md)),
and a key set that varies from record to record was an accepted consequence of ADR-0020 §6 in
`1.0.0` already.

MINOR's wording — "additive only" — is stretched here, deliberately and on the record. The bump is
not additive; it is a narrowing that the contract table does not name. PATCH understates a 93.5%
change in output width, and MAJOR would break every pinned consumer over a null nobody was promised.

## Consequences

- **An agent that branches on `custom_fields[hash] === null` breaks silently.** Named rather than
  hidden. No document ever promised the null, and `hash in custom_fields` was already unsafe under
  ADR-0016's projection.
- **The push-down invariant is unaffected.** [ADR-0016](0016-field-projection.md) §7's property — the
  pushed-down request and local trimming produce identical bytes — still holds, because the drop runs
  on whatever the request returned, in both paths.
- **The measurement inverts ADR-0016's open question.** Its note that `custom_fields=` with an empty
  value is "the single largest response-size win available" was about the wire. This ADR takes the
  larger win on the output side without probing undocumented semantics; the wire probe remains open
  and remains optional.
- **`AGENTS.md` gains a sentence**: a custom field with no value is absent from the block, and the
  account's full field list comes from `pd fields list`.
- **`--pretty` gets sparser columns**, which is the existing behaviour of absence and needs no rule
  of its own.
- **ADR-0020 §6's boundary list is now two entries, not three.** Only `null`/absent, and `id`.
