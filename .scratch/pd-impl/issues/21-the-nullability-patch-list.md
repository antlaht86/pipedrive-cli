# 21 — The nullability patch list

**What to build:** `pd deals list` run against a real Pipedrive account emits deals. Today it emits `invalid_response`, exit 1, on the first page — not because the walk is wrong, but because the v2 OpenAPI document describes fields the API does not send.

**Blocked by:** 05

**Status:** superseded

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
- **A third fault, found by ticket 07: `.default()` materialises a value Pipedrive never sent.** `zGetProductsItem` carries `tax: z.number().default(0)`, `is_deleted`, `is_linkable`, `billing_frequency` and `billing_frequency_cycles`, all with spec defaults. An absent key therefore parses to the default and is **emitted** as one, which quietly contradicts [ADR-0020](../../../docs/adr/0020-value-formatting-and-absence.md) §6: a caller reading `tax: 0` cannot tell it from a tax Pipedrive actually reported. Decide per field whether the spec's `default` is a real API guarantee or a request-side one; the latter belongs in the patch list beside the nullability entries.
- **Absence and nullability are two different faults here.** `expected_close_date` on a deal with no expected close date may be absent rather than `null`. `NULLABLE_IN_PRACTICE` marks `nullable: true`, which does not make a required field optional. Decide which of the two each observed field needs.
- Every correction is a `parser.patch` entry against the input spec, then `bun run openapi-ts`, then the regenerated output is committed. **Nothing under `generated/` is hand-edited** — ADR-0006 §9, and `test/generated-read-only.test.ts` guards the read-only half of it.
- Nine resources reach this ticket, not one. Ticket 07's eight others share the shape and will share the fault.
- The regression test is a replay fixture per resource holding a record shaped like the observed one — an open deal with no `won_time`, `lost_time` or `expected_close_date` — asserting it survives validation and emits.

The boxes below stay unticked deliberately. All five outcomes are answered — see `## Comments` — but
none by this ticket's own method, and ticking them would read as though the patch list shipped.

- [ ] An open deal with no `won_time`, `lost_time` or `expected_close_date` survives the record schema and emits (replay fixture recorded from a real response)
- [ ] The patch distinguishes *nullable* from *absent* and each observed field gets the right one
- [ ] Every correction is a `parser.patch` entry; no generated file is hand-edited
- [ ] The nine first-surface resources are each covered by an observed response, not by inference from the spec
- [ ] `pd deals list` against a live account emits deals and exits 0

## Comments

**2026-08-17 — superseded, not done.** The ticket's premise held: `pd deals list` did fail on the
first page of a real account, and the three fields named above are the reason. Its method did not.
The evidence ADR-0006 §9 demands is a recorded response per resource, ADR-0019 §9's recorder writes
those into this repository as versioned fixtures, and the project's owner declined to commit real CRM
data under any of the arrangements ADR-0021 §9 considered. That removes the only admissible evidence,
and reading the spec instead is the one method ADR-0006 §9 forbids.

[ADR-0029](../../../docs/adr/0029-the-record-interior-passes-through.md) answers the fault at the
level above the patch list: `pd` validates what it reads and passes through what it only emits, so
the generated record schemas stop gating records and become the `--fields` vocabulary alone. Every
schema that still runs is one `pd` wrote itself from an observed response.

All five acceptance criteria are answered, none of them the way this ticket proposed:

- An open deal with no `won_time`, `lost_time` or `expected_close_date` emits — `test/deals-list.test.ts`,
  "the record interior passes through". No recorded fixture was needed, because no interior is read.
- Nullability versus absence is no longer a distinction `pd` has to get right, because nothing parses
  the interior to get it wrong. What ADR-0020 §6 then does with either — the writer omits both from
  the line — is unchanged.
- No new `parser.patch` entry exists, and no generated file is hand-edited. `openapi-ts.config.ts` is
  untouched.
- The nine first-surface resources are covered by one rule rather than by nine observations.
- `pd deals list` against a live account emits and exits 0. **Verified by hand, 2026-08-17**, against
  a real production account: `pd deals list --limit 5` returned `emitted: 5, skipped: 0, requests: 1`.
  The first record carried `status: "open"`, no `won_time`, no `lost_time` and no
  `expected_close_date` — the exact shape this ticket was opened for. Two further records carried no
  `org_id`. Nothing was recorded to disk; the evidence is this paragraph.

The third fault the ticket recorded — `zGetProductsItem`'s `tax: z.number().default(0)` materialising
a value Pipedrive never sent, against ADR-0020 §6 — closes with it, for the same reason.
