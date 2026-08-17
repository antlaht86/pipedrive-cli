# ADR-0020: Money, time, and what absence looks like in a raw record

Status: accepted, partly superseded
Date: 2026-08-13
Partly superseded by: [ADR-0030](0030-the-null-custom-field-drops.md) — §6's `custom_fields`
exemption is withdrawn, so a `null`-valued hash key is now dropped like any other absent value. The
exemption survives one level down: a custom-field **value**'s interior is untouched. Everything else
in §6, and every other section, stands unchanged.
Deciding ticket: [Value formatting: money, currency and time in machine output](../../.scratch/pd-cli-design/issues/29-grilling-value-formatting.md)
Extends: [ADR-0006](0006-validation-placement-and-rejection.md) — the record schema it made `pd`'s own now has a stated serialisation rule for empty values
Corrects: [ADR-0016](0016-field-projection.md) §2 and [ADR-0018](0018-related-entity-expansion.md) Consequences — one nested block does exist, `products.prices`
Corrects: this ticket's own premise about `weighted_value` — see §2
Confirms: [ADR-0008](0008-resolution-mechanics.md) §1 and §4 — `custom_fields` stays byte-identical with and without `--resolve`, and the resolved half's neutral formatting is untouched

## Context

[ADR-0008](0008-resolution-mechanics.md) §4 settled how a **resolved** value is written —
`"12000.00 EUR"`, locale-free and byte-stable — and said in as many words that the raw half was still
open. The raw half is the default output, so this ADR decides the bytes almost every caller actually
reads.

[ADR-0006](0006-validation-placement-and-rejection.md) makes the record schema `pd`'s own and strips
unknown keys. That turns every question here from a passthrough question into a free choice, and by
[ADR-0014](0014-distribution.md) §5 a free choice that is a breaking change to revisit.

Four facts were read out of Pipedrive's v2 OpenAPI document rather than assumed:

| fact | evidence in the v2 spec |
| --- | --- |
| deal money is a number with a flat sibling code | `value: type: number`, `currency: type: string`, siblings on the deal object |
| timestamps carry no declared format | `add_time`, `update_time`, `close_time`, `won_time`, `lost_time`: `type: string`, **no** `format:` key; examples show `'2021-01-01T00:00:00Z'` |
| one date field is declared, and it is date-only | `expected_close_date: type: string, format: date`; activities carry `due_date: '2021-01-01'` beside `due_time: '15:00:00'` |
| products carry a nested price array | `prices: type: array`, items `{product_id, price, currency, cost, direct_cost, notes}` |

Custom fields are a separate shape and were already researched: monetary is
`{ "value": 500, "currency": "USD" }` inside `custom_fields`, daterange adds `until`, timerange adds
`until` and `timezone_name` (research 03).

## Decision

### 1. Money is a JSON number, and the currency code stays a flat sibling

`value` is emitted as a JSON number, exactly as Pipedrive sends it. `currency` stays a sibling key at
the top level of the record. The same rule covers `arr`, `mrr` and `acv`, which carry no currency
sibling of their own and are read in the deal's `currency`.

A string was rejected on cost with no matching benefit. The precision argument for a string requires
an amount above 2^53, which no CRM deal reaches; against that, a string forces every consumer —
including an agent doing arithmetic in whatever language its harness runs — to parse before it can
compare or sum.

Folding `value` and `currency` into one object was rejected for a harder reason than taste: it would
create a nested block in the record, and [ADR-0016](0016-field-projection.md) §2's selector grammar has
no way to name one. `--fields value` would then either drag the currency along invisibly or need a
dotted path the grammar refuses. The flat pair is nameable as it stands: `--fields value,currency`.

### 2. `weighted_value` does not exist, so it settles nothing

The ticket asked whether `weighted_value`, `value` and product prices share a shape. They cannot
disagree: **`weighted_value` is not a field in the v2 API**. The string appears in the document only
inside the description of `probability` ("Used/shown when the deal weighted values are used"). It is a
UI-computed figure, not a response field, and `pd` neither emits nor computes it.

Product prices *do* differ from deal money, and §7 handles that.

### 3. Time passes through byte-for-byte, and `pd` never parses it

Every time-valued field is validated as a string and emitted unchanged. No `Date` construction, no
timezone conversion, no re-serialisation, no normalisation of `'2021-01-01T00:00:00Z'` into anything
else.

The reason is §Context's second row. The v2 spec declares these fields as bare `type: string` with no
`format`, so there is no documented format for `pd` to normalise *to* and no promise that today's
observed shape is the whole set. A normalising `pd` would have to parse an undeclared format and would
become the component that can be wrong about time — silently, on a field the caller cannot cross-check.
Passthrough is also what locked point 6 wants: the same record produces the same bytes on every
machine, in every locale, in every process timezone.

The cost is stated rather than hidden: a consumer that needs a `Date` builds it itself, and two fields
of `pd`'s output may in principle differ in format if Pipedrive's do.

### 4. `due_date` and `due_time` stay two fields, and date-only fields are account-local

Activities carry `due_date` (`'2021-01-01'`) and `due_time` (`'15:00:00'`) as separate keys. `pd` keeps
them separate. Joining them would require choosing a timezone to join them *in*, which is precisely the
thing §5 refuses to know.

`expected_close_date`, `due_date` and `due_time` are wall-clock values relative to the Pipedrive
account's timezone setting. `pd` emits them verbatim and states in `AGENTS.md` that it does not
interpret them.

### 5. The account timezone is never read, and that is said out loud

`pd` issues no request to learn the account timezone. `GET /users/me` is already excluded by
[ADR-0007](0007-the-narrow-v1-users-client.md) and [ADR-0012](0012-authentication-and-credential-resolution.md)
§7, and [ADR-0010](0010-budget-guard.md) is unsympathetic to a request that serves no record.

Consequently `pd` makes no claim about what a date-only field means in absolute time. An instant-valued
field (`add_time` and friends) is unambiguous as Pipedrive sends it; a date-only field is not, and the
caller resolves the ambiguity with knowledge `pd` does not have.

The one place a timezone does appear in output is the `timerange` custom field, whose value object
carries `timezone_name` (research 03). It rides along as data under [ADR-0008](0008-resolution-mechanics.md)
§1's byte-identical rule. `pd` does not apply it to anything.

### 6. An empty value is an absent key

**A field with no value is omitted from the record. A missing key means "no value" and nothing else.**

This is the user's decision, taken against the alternative of emitting every schema key with `null`.
The winning argument is the same one that bought `--fields` its existence in ADR-0016: the agent pays
for stdout in the one budget it cannot refill. A deal carries `probability`, `lost_reason`,
`close_time`, `origin_id`, `channel`, `channel_id`, `arr`, `mrr` and `acv` as nullable fields, so a
null-emitting record spends eight to ten keys per line saying nothing, on every line of a 40,000-record
walk.

Three boundaries make the rule mechanical rather than a matter of judgement:

- **Only `null` and absent are absent.** An empty array (`label_ids: []`), an empty string and a zero
  are values, and are emitted. `0` and absent therefore never collide on a money field.
- **`custom_fields` is exempt.** ADR-0008 §1 requires that block byte-identical with and without
  `--resolve`, and it is passthrough data rather than `pd` schema. A hash key Pipedrive sends with a
  `null` value stays. An empty `custom_fields` object is emitted as `{}` — it is a block, not a value.
- **`id` is never absent**, by [ADR-0016](0016-field-projection.md) §1.

The accepted cost: a record's key set varies from record to record, so a consumer building a table has
to fill the gaps itself. That is a downstream shell-pipeline concern, and the map's tiebreaker — the
agent wins — points the other way.

### 7. `products.prices` is a nested block, and it is the only one

A product's `prices` is an array of objects: `{product_id, price, currency, cost, direct_cost, notes}`.
`products` is one of ADR-0009 §2's nine resources, so this shape is in the first surface.

`pd` keeps it. A product record without its prices answers nothing, and flattening a
one-price-per-currency array into sibling keys would invent a key language for a shape Pipedrive
already gives a name.

Two prior claims are corrected rather than worked around:

- [ADR-0016](0016-field-projection.md) §2 justified stopping the selector grammar at one level with
  "`pd`'s records are one level deep plus the custom-field block". The premise is false; the decision
  survives. `prices` is selectable as a bare top-level name (`--fields prices`), whole, and no dotted
  path reaches inside it. Extending the grammar for a single array on a single resource would buy one
  case a permanent surface.
- [ADR-0018](0018-related-entity-expansion.md) Consequences claimed no nested block exists in a record.
  It does, and the claim it was supporting — that deduplicated sibling `record` lines would force
  ADR-0016 §2's grammar to reach inside a nested block — is unaffected: `prices` is still not reachable
  by a selector, so the objection stands on the same footing.

Money inside `prices` follows §1: `price`, `cost` and `direct_cost` are JSON numbers, `currency` is a
flat sibling **inside each price object**. §6's omission rule applies inside those objects too, so an
absent `cost` is an absent key.

### 8. `--fields` on an empty field yields a shorter line, not an error

Selecting a field that exists in the schema but has no value on this record emits the record without
it. `--fields close_time` over a walk of open deals emits `{"id": …}` records and nothing more.

This is the predictable behaviour §6 promises, and it needs no new signal: an unknown *name* is still
exit 2 offline (ADR-0016 §5), because that is a schema question answerable before any request, while an
empty *value* is data. No `warning` is emitted — one per record would be noise on the same budget §6
just protected.

### 9. `--pretty` is unaffected

[ADR-0002](0002-output-format.md) makes `--pretty` an unstable human table with no contract. A human
table renders an absent field as an empty cell and may format numbers and dates however reads best.
Nothing in this ADR constrains it, and nothing about it constrains the machine format.

## Assumptions recorded rather than decided

- **Observed timestamp shape.** Every example in the v2 document uses `2021-01-01T00:00:00Z`. `pd`
  validates `type: string` and does not assert this shape, so a Pipedrive change in format passes
  through instead of failing a walk. That is deliberate under §3, and it means `pd` cannot warn about
  such a change either.
- **Money magnitude.** §1 assumes no amount exceeds 2^53. If a currency with no decimal subunit and an
  extreme scale ever appears, the number is where it breaks, and fixing it is a breaking change.

## Consequences

- **The default record is smaller than the schema.** Absence is the common case for nullable fields, so
  a typical deal line drops eight to ten keys. This compounds with `--fields`, and neither mechanism
  touches [ADR-0003](0003-pagination-bounding-and-partiality.md)'s trailer arithmetic: omission removes
  keys, never records.
- **`pd` never parses a date or a number it did not have to.** Money is passed through as a number and
  time as a string, so the only value transformation in the whole tool is `--resolve`'s, which
  ADR-0008 §4 already fixed as locale-free.
- **The record shape is now fully specified without a nullability column.** The manifest's per-command
  selectable-field list (ADR-0016) states which names are legal; §6 states what their absence means.
  Nothing else is needed, and `manifest_version` does not move — this ADR specifies the first surface
  rather than changing it.
- **One nested block exists in the contract**, and the selector grammar deliberately cannot see inside
  it. If a second nested shape ever ships, the grammar decision is reopened rather than stretched.
- **A ticket premise died.** `weighted_value` is not an API field, so no future reader should look for
  it in the record or wonder why it is missing.
- **Net agent-visible surface: zero additions.** No flag, no line type, no warning kind, no error
  variant, no exit-code change.
