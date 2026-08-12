# Custom field resolution mechanics

Type: grilling
Status: resolved

Blocked by: 03, 14

## Question

A flag turns hashes and option ids into names and labels. How does that actually work?

- When the field schema is fetched. Eagerly on any command that might need it, lazily on first hash encountered, or only when the flag is set. Only-when-flagged is the obvious answer, but confirm nothing else needs the schema.
- How many requests resolution costs, per ticket 03, and whether that count is visible in the budget accounting before the run starts.
- Where the mapping is cached — ticket 14's cache, presumably — and how a stale mapping is detected when a field was added or an option renamed since the last fetch.
- Cache miss mid-stream: records are already flowing and a hash appears that the mapping does not know. Fetch mid-stream and stall the output, emit the raw hash with a marker, or fail. Each has a cost, and the mid-stream fetch interacts with ticket 12's error handling.
- Disambiguation when two custom fields on the same entity share a display name. Suffix, qualify with the hash, refuse to resolve either, or resolve and accept the collision. Whatever is chosen must keep the output parseable, since a duplicate key in a JSON object is not.
- What resolution does to output stability. Locked point 6 says raw hashes stay the default so output is diffable — so does resolved output need to be deterministic too, and what makes it so.
- The shape of resolved output: replace the hash key in place, or add a parallel resolved block alongside the raw values? Replacing is readable; adding preserves the raw values a subsequent query would need.
- Field types where the value is not the label — monetary with its currency, user and person references, address subfields, labelled phone and email arrays. Does the flag resolve those too, or only enum-style options? The flag's name should reflect the answer.
- What happens when resolution fails partway. Does the run degrade to raw hashes, or fail?

Record as an ADR.

## Context added while resolving other tickets

- [Custom fields, hash keys and enum option labels](03-research-custom-fields-and-option-labels.md) found that part of this problem may not be ours: **`include_option_labels` makes Pipedrive resolve enum and set values server-side**, returning `{ id, label }` objects. Coverage is partial — only some endpoints accept it — so decide whether `pd` uses it where available and falls back to a client-side mapping elsewhere, or ignores it for uniform behaviour.
- Field schemas are in **v2** for deals, persons, organizations, products and activities, so this feature needs no v1 client. Only `leadFields` and `noteFields` are v1-only.
- The per-account nature of field hashes means the mapping cache must be keyed by profile — see [Storing API credentials safely for a local CLI](08-research-secure-credential-storage.md), which reaches the same conclusion from the credential side. **[ADR-0005](../../../docs/adr/0005-cache-design.md) overrode this**: the key is a hash of the credential, not the profile name, because a profile name is not an account identity.
- [ADR-0005](../../../docs/adr/0005-cache-design.md) settled several bullets of this ticket by derivation:
  - **Where the mapping is cached**: `dealFields`, `personFields`, `organizationFields` and
    `productFields` are cached for 24 h; `users` for 1 h. That list is closed, so **`activityFields`,
    `leadFields` and `noteFields` are never cached** — resolution on those entities costs a request per
    invocation, and this ticket owns whether that is acceptable or the flag simply refuses there.
  - **How a stale mapping is detected**: an unrecognised 40-character hex key, or an unknown
    `owner_id`, forces one schema refresh regardless of TTL. This ticket still owns the *mid-stream*
    case — the refresh has to happen while pages are already flowing, which touches ADR-0004's page
    atomicity.
  - **Budget visibility**: a cache hit does not count against `--max-requests`, so the request cost of
    resolution is not knowable before the run — it is 0 or 1 per schema depending on cache state.
  - **Failure partway**: a cache read failure already degrades to a fresh fetch plus a `warning` line.
    A *resolution* failure is a different event and this ticket must still decide it.
- [ADR-0006](../../../docs/adr/0006-validation-placement-and-rejection.md) and the v1 scope decision
  taken with it narrow this ticket in three ways:
  - **Every hash this ticket resolves arrives inside `custom_fields`**, a `z.record(z.string(), z.unknown())`
    on a v2 record. Top-level 40-character hash keys were a v1 shape, and v1 is out of scope apart
    from `users`. `custom_fields` is explicitly protected from any patch that would close it, because
    stripping is otherwise the default.
  - **`leadFields` and `noteFields` no longer matter.** Leads and notes are out of scope, so the
    v1-only field schemas research 03 flagged are simply never fetched. `activityFields` remains the
    only uncached schema this ticket has to rule on.
- [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) fixed three things this ticket
  must build on:
  - **The flag is `--resolve`, not `--resolve-fields`**, and it is one switch covering custom field
    hashes, option labels and owner ids together. This ticket owns what it does to custom fields, not
    what it is called.
  - **Resolution is additive and preserves raw values.** ADR-0007 settled it for owner ids
    (`owner_name` beside `owner_id`), on locked point 6's diffability argument. This ticket's
    "replace in place versus parallel block" bullet inherits that precedent — deviating for custom
    fields is now an argument to be made, not an open choice.
  - **The cold-cache request cost of `--resolve` includes one 20-token v1 `users` fetch** on top of
    the field schemas.
  - **The `warning` line now carries a `kind`**, and warnings are deduplicated by
    `(resource, field path, zod issue code)`. Whatever this ticket decides an unresolvable hash emits,
    it must fit that shape — and a per-record warning for a hash appearing on 40,000 records would be
    reported once, not 40,000 times.

## Answer

Recorded in full as [ADR-0008](../../../docs/adr/0008-resolution-mechanics.md). Summary, bullet by bullet against the question:

- **When the schema is fetched**: only when `--resolve` is set. Confirmed nothing else needs it — ADR-0006 types `custom_fields` as `z.record(z.string(), z.unknown())`, so validation never reads the schema.
- **Request cost and its visibility**: at most four fixed requests on a cold cache — the read entity's own field schema at 10 tokens, `users` at 20, `pipelines` and `stages` at 5 each — and zero on a warm one. A run reads one entity, so it never pays for more than one schema. Relation resolution is the variable part, batched 100 ids per request via the `ids` query parameter, and capped at 50 requests per run by default.
- **Where the mapping is cached, and staleness**: ADR-0005's cache, whose closed list grows from five entries to eight. `activityFields` joins — it is v2 and costs 10 tokens like the four already cached, and its exclusion only ever made sense in the company of `leadFields`/`noteFields`, which are now out of scope. `pipelines` and `stages` join at 24 h. The rule is now "every v2 `*Fields` schema, 24 h".
- **Cache miss mid-stream**: the page is held, one schema refresh is issued, the page is emitted resolved. Capped at one refresh per schema per run; after that unknown hashes go raw with one `unknown_custom_field` warning. Page atomicity per ADR-0004 is preserved.
- **Disambiguation of duplicate display names**: dissolved rather than solved. `custom_fields_resolved` is keyed by hash, so a collision is impossible by construction.
- **Output stability**: `custom_fields` is byte-identical with and without the flag. Resolved values are formatted neutrally — `"12000.00 EUR"`, not `"12 000,00 €"` — so two machines produce the same bytes.
- **Shape**: parallel block, not in-place enrichment. Follows ADR-0007 §7's additive precedent rather than deviating from it.
- **Field types beyond enum**: enum, set, user, person/organization relations, monetary and address all get a `label`. Types whose raw value is already legible get a `name` and no `label`. The flag also grows ADR-0007 §7's table from three entries to seven, adding `person_name`, `org_name`, `pipeline_name` and `stage_name`.
- **Failure partway**: degrade, never fail. The failing resolver drops for the run, one `warning` with an ADR-0006 §6 `kind` is emitted, the trailer reads `resolved: "partial"`, exit 0.

Decided against `include_option_labels`: the spec has it replace the plain id rather than add to it, which would make `custom_fields` depend on the flag, and its coverage skips activities and products. The schema is fetched for field names anyway, so client-side resolution is free and uniform.

New CLI surface: `--resolve-budget <n>`. New trailer field: `resolved`. New warning kinds: `unknown_custom_field`, `resolution_budget_exhausted`.
