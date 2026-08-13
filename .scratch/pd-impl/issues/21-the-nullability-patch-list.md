# 21 — The nullability patch list

**What to build:** `pd deals list` run against a real Pipedrive account emits deals. Today it emits `invalid_response`, exit 1, on the first page — not because the walk is wrong, but because the v2 OpenAPI document describes fields the API does not send.

**Blocked by:** 05

**Status:** ready-for-agent

Normative: [ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md) §9 (schema corrections are made on the spec, never on the generated output), §4 (a first page with no survivors), [ADR-0019](../../../docs/adr/0019-testing-strategy.md) §9 (the live suite).

## What ticket 05 found

The generated `zGetDealsItem` types `won_time` and `lost_time` as non-nullable strings and `expected_close_date` as a required `z.iso.date()`. An **open** deal has none of the three. Under `propertiesRequiredByDefault: true` — which ADR-0006 §9 keeps, because the v2 spec declares almost no `required` arrays — every open deal therefore fails the record schema.

A page of open deals is a page with zero survivors, and ADR-0006 §4 makes a first page with zero survivors `invalid_response`, exit 1. The rule is doing exactly its job: *the schema does not describe this resource*. It does not.

`next_cursor`, `person_id` and `org_id` are already patched in `openapi-ts.config.ts`'s `NULLABLE_IN_PRACTICE`, and that set is where this work lands.

## Why it was not fixed in ticket 05

ADR-0006 §9: *"The patch list grows from observed responses, not from guesswork. Which fields are marked nullable in the spec is arbitrary rather than systematic — `close_time` is nullable while `won_time` is not — so it cannot be reasoned about in advance."*

Adding fields to the set by reading the spec and guessing is the one method that ADR forbids. The list has to come from responses somebody actually saw.

Notes for the implementer:

- The evidence is a **recorded response per resource**, from the live suite of ADR-0019 §9 or from a hand-run against a real token. Record what the API sent, then widen the spec to match it — never the other way round.
- Two mechanical constraints, both easy to get wrong and both already stated in ADR-0006 §9: Pipedrive's spec is **OpenAPI 3.0**, where nullability is `nullable: true`; appending `"null"` to a `type` array silently degrades the schema to `z.unknown().nullable()`. And `propertiesRequiredByDefault: true` flips **presence**, never **null-acceptance** — a field that is sometimes absent needs its own treatment, which `NULLABLE_IN_PRACTICE` does not currently give.
- **Absence and nullability are two different faults here.** `expected_close_date` on a deal with no expected close date may be absent rather than `null`. `NULLABLE_IN_PRACTICE` marks `nullable: true`, which does not make a required field optional. Decide which of the two each observed field needs.
- Every correction is a `parser.patch` entry against the input spec, then `bun run openapi-ts`, then the regenerated output is committed. **Nothing under `generated/` is hand-edited** — ADR-0006 §9, and `test/generated-read-only.test.ts` guards the read-only half of it.
- Nine resources reach this ticket, not one. Ticket 07's eight others share the shape and will share the fault.
- The regression test is a replay fixture per resource holding a record shaped like the observed one — an open deal with no `won_time`, `lost_time` or `expected_close_date` — asserting it survives validation and emits.

- [ ] An open deal with no `won_time`, `lost_time` or `expected_close_date` survives the record schema and emits (replay fixture recorded from a real response)
- [ ] The patch distinguishes *nullable* from *absent* and each observed field gets the right one
- [ ] Every correction is a `parser.patch` entry; no generated file is hand-edited
- [ ] The nine first-surface resources are each covered by an observed response, not by inference from the spec
- [ ] `pd deals list` against a live account emits deals and exits 0
