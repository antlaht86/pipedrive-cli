# Value formatting: money, currency and time in machine output

Type: grilling
Status: resolved

Blocked by: 13, 15, 25

## Question

How are money and time values represented in a `record` line's raw fields — the ones a caller sees
**without** `--resolve`?

[ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) §4 settled the resolved half: a resolved
`label` is locale-free and byte-stable, `"12000.00 EUR"` rather than `"12 000,00 €"`. It said nothing
about the raw half, and the raw half is the default output.

- **Money.** A monetary field arrives as a `value` plus a `currency` code. Does `pd` emit the number as
  a JSON number, or as a string? A JSON number is the obvious answer and it is the one that loses
  precision on a large amount in a currency with no decimal subunit; a string is exact and forces every
  consumer to parse. [ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md) makes the
  record schema `pd`'s own, so this is a free choice rather than a passthrough — which also means
  changing it later is a breaking change under [ADR-0014](../../../docs/adr/0014-distribution.md) §5.
  Note that Pipedrive's own `weighted_value`, `value` and product prices may not share a shape.
- **Currency.** Is the code emitted as a sibling field, folded into one object, or left exactly where
  Pipedrive puts it? [ADR-0016](../../../docs/adr/0016-field-projection.md) §2 makes this a grammar
  question too: a caller must be able to name the thing in `--fields`, and a nested money object would
  be the first nested block in the record — which ADR-0018's Consequences claim does not exist.
- **Time.** `add_time`, `update_time`, `due_date`, `expected_close_date` and friends. Pipedrive returns
  timestamps in a documented format at some timezone; does `pd` pass them through byte-for-byte, or
  normalise to a single representation? Passing through is stable and diffable and defers the question
  to every consumer; normalising is one decision made once, but it makes `pd` the thing that can be
  wrong about time.
- **The account timezone problem.** A Pipedrive account has a timezone setting, and a date-only field
  means something different under it. Is that a fact `pd` must read (which would be a request, and
  [ADR-0010](../../../docs/adr/0010-budget-guard.md) is unsympathetic), a fact it states it ignores, or
  a non-problem because every timestamp is already unambiguous?
- **Null and absence.** A money field with no amount, a date field never set. Does `pd` emit `null`,
  omit the key, or pass Pipedrive's own choice through? ADR-0006 strips unknown keys, so absence is
  already `pd`'s decision to make, and [ADR-0016](../../../docs/adr/0016-field-projection.md) means a
  projected field that is absent still has to behave predictably.

Record as an ADR.

## Answer

Recorded as [ADR-0020](../../../docs/adr/0020-value-formatting-and-absence.md).

**Money.** JSON number, passed through, with `currency` staying a flat sibling key — `arr`, `mrr` and
`acv` included, none of which carry a currency of their own. A string was rejected because its only
argument needs an amount above 2^53; folding the pair into an object was rejected because it would
create a block ADR-0016 §2's grammar cannot name, whereas `--fields value,currency` already works.

**The ticket's `weighted_value` premise is false.** The field does not exist in the v2 API; the string
appears only inside `probability`'s description. It is a UI figure, so there is no shape disagreement
to settle and `pd` neither emits nor computes it.

**Time.** Byte-for-byte passthrough, validated as a string and never parsed. The v2 spec declares these
fields as bare `type: string` with no `format`, so there is no documented target to normalise to, and a
normalising `pd` would become the component that can be silently wrong about time. `due_date` and
`due_time` stay two fields, because joining them would require choosing the timezone the next point
refuses to know.

**Account timezone.** Never read — no request, `users/me` already excluded by ADR-0007 and ADR-0012.
`pd` states that date-only fields are account-local wall clock and does not interpret them. The
`timerange` custom field's `timezone_name` rides along as data and is applied to nothing.

**Absence (user's decision).** A field with no value is omitted; a missing key means "no value". The
agent's context budget wins over a fixed record shape — a deal carries eight to ten nullable keys, on
every line of a 40,000-record walk. Boundaries: only `null`/absent are absent (`[]`, `""` and `0` are
values), `custom_fields` is exempt under ADR-0008 §1's byte-identical rule, `id` is never absent, and
`--fields` naming an empty field yields a shorter line with no warning — an unknown *name* is still
exit 2 offline.

**Found and corrected: one nested block does exist.** `products.prices` is an array of
`{product_id, price, currency, cost, direct_cost, notes}`, on a resource inside ADR-0009 §2's nine. It
is kept — a product without prices answers nothing — and selectable only as a bare `prices`, with no
dotted path inside. This falsifies ADR-0016 §2's stated premise and ADR-0018's Consequences claim; both
decisions survive, and both ADRs are backlinked.

**Net surface: zero.** No flag, no line type, no warning kind, no error variant, no exit-code change,
and `manifest_version` does not move.
