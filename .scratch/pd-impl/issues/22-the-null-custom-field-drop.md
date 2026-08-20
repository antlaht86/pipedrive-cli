# 22 — The null custom field drop

**What to build:** a `record` line whose `custom_fields` block carries only the custom fields that
have a value. Today the block carries every custom field defined on the account, and on a measured
real deal 83 of 87 are `null` — 4259 bytes of record, 275 of it data.

**Status:** done

Normative: [ADR-0030](../../../docs/adr/0030-the-null-custom-field-drops.md) (all six sections),
[ADR-0020](../../../docs/adr/0020-value-formatting-and-absence.md) §6 (the absence rule this now
applies unexempted), [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md) §1 (the block stays
byte-identical across `--resolve`), [ADR-0016](../../../docs/adr/0016-field-projection.md) §5–§7
(projection, the unmatched-hash warning, the push-down).

## The measurement that decided it

`pd deals list --limit 1 --fields custom_fields` against a real account, one deal:

| | |
| --- | --- |
| hash keys | 87 |
| `null` | 83 |
| filled | 4 |
| record as emitted | 4259 bytes |
| with nulls dropped | 275 bytes |

Record it as a fixture. It is the regression case, and it is also the only evidence in the repo that
the block is mostly null in practice — the existing `test/support/` doubles show filled hashes only.

## What to change

1. Remove `custom_fields` from the absence rule's exemption list. A hash whose value is `null` is not
   emitted.
2. **Do not recurse into a custom-field value.** `{"value":500,"currency":null}` is emitted verbatim.
   This is the one place the absence rule stops at a boundary it could cross, so it needs a comment
   naming ADR-0030 §2 — otherwise a later reader "fixes" it.
3. `custom_fields` still emits as `{}` when every hash drops.
4. `custom_fields_resolved` is built from the surviving hashes only.
5. The drop runs in both `--resolve` modes and in both push-down paths, so no output differs by mode.

## Acceptance

- [x] A deal whose 87 hashes include 83 nulls emits a `custom_fields` block with 4 keys.
- [x] A record whose every hash is null emits `"custom_fields":{}`, and the record line still emits.
- [x] A monetary custom field with `{"value":500,"currency":null}` emits both keys, unchanged.
- [x] The same record with and without `--resolve` produces a byte-identical `custom_fields` block.
- [x] `custom_fields_resolved` contains no entry for a dropped hash.
- [x] `--fields custom_fields.<hash>` on a hash that is null in every record of the run: each record
      emits `{"type":"record","record_type":"deal","id":N,"custom_fields":{}}`, and the run emits one
      `warning` with `kind: "unmatched_field_selector"` naming the hash.
- [x] ADR-0016 §7's push-down property test still passes: pushed-down and locally trimmed output are
      byte-identical.
- [x] Applies to every resource that has the block — `deals`, `persons`, `organizations`,
      `activities`, `products` — not to `deals` alone.
- [x] No new flag. `--include-empty` and its spellings do not exist.
- [x] `AGENTS.md` states that a custom field with no value is absent, and points at `pd fields list`
      for the account's full field list.
- [x] ADR-0020 carries its `Partly superseded by` header (done when this ticket was written); its §6
      body stays as written, per the repo's convention that an ADR records what was decided then.
- [x] Version moves to `1.1.0`. `manifest_version` does **not** move.
- [x] Any normative sample under the ADR-0002 drift gate that carries a null hash is regenerated in
      the same commit.

## Out of scope

- The wire-side probe of `custom_fields=` with an empty value (ADR-0016's open question). Still
  optional, still unprobed.
- Reaching inside a custom-field value object. ADR-0030 §2 decided against it; reopening it is a new
  ADR.

## Comments

Implemented in three places, and the split is deliberate rather than accidental duplication:

- `src/lib/output/ndjson-writer.ts` — `filledCustomFields`, called from `present()`. That is the one
  call site for every record line, so the drop reaches all five resources that carry the block
  without a per-resource branch.
- `src/lib/output/resolution.ts` — `resolveRecord` skips a null hash, so the resolved block cannot
  grow an orphan whatever order the stages run in.
- `src/lib/output/projection.ts` — `apply` skips a null hash, which is what makes "matched" mean
  *survived into the output* (ADR-0030 §5).

Two findings from `/code-review` were fixed before the commit rather than filed:

1. **The writer's new guard destroyed a wire anomaly.** The first version coerced a `custom_fields`
   that was not an object to `{}`, where the old `value ?? {}` had passed it through. ADR-0029 keeps
   `pd` out of interpreting a shape it does not own, so a non-object block now travels verbatim, with
   a test.
2. **The unknown-hash scan still counted dropped nulls.** A null hash absent from the field schema
   spent a schema-refresh request, marked the run `partial`, and emitted an `unknown_custom_field`
   warning claiming a key was "emitted raw" that was never emitted at all. An absent key cannot be an
   unrecognised one; the scan skips nulls, with a test asserting one `dealFields` request, no warning
   and `resolved: "full"`.

Also closed the review's two coverage gaps: the drop is now asserted across all five live resources
(`test/resources.test.ts`), and the ADR-0008 §1 byte-identity of the narrowed block with and without
`--resolve` has its own test, which the rewritten deals-list test had left implicit.

No normative sample needed regeneration — none carries a null hash. `--pretty` needed no change: it
renders from the post-drop record and yields empty cells.

ADR-0025's nested-absence section repeated the withdrawn exemption; it gained a
`Partly superseded by` header rather than a body edit.

585 tests pass, `tsc --noEmit` and `eslint .` clean, `dist/pd` builds and reports `1.1.0`.

**2026-08-19 — verified against the live account.** `pd deals list --limit 1 --fields custom_fields`
emitted a record whose `custom_fields` block holds **4** filled entries, against the 87 the account
defines — the ratio this ticket measured. The whole record contains no `null` at any depth. Its
top-level keys are `type`, `record_type`, `id` and `custom_fields`, which is the projection asked
for and nothing else.
