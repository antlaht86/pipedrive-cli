# 11 — `--resolve`, fixed-cost half

**What to build:** An agent runs `pd deals list --resolve` and `owner_id: 12` gains an `owner_name` beside it, a 40-character custom-field hash gains a name and an option label, and the stage id gains a stage name. The raw values survive **byte-identical**, so the output stays diffable and re-queryable. On a warm cache this costs zero extra requests. If any of it fails, the run degrades to raw ids, says so on the trailer, and still exits 0.

**Blocked by:** 08, 10

**Status:** done

Normative: ADR-0008 (resolution mechanics), ADR-0007 (owner ids and the v1 users client).

Notes for the implementer:

- **One flag**, `--resolve`, covering custom-field hashes, enum and set option labels, owner ids and relations. The caller must not have to know which kind of unreadable id they are looking at before they can ask for readability.
- **Always additive.** Raw values survive byte-identical.
- Seven standard pairs: `owner_id`→`owner_name`, `creator_user_id`→`creator_user_name`, `user_id`→`user_name`, `person_id`→`person_name`, `org_id`→`org_name`, `pipeline_id`→`pipeline_name`, `stage_id`→`stage_name`.
- **An unresolvable id omits its sibling key** — not `null`, not the id as a string. The caller must never receive a name that is secretly a number.
- Custom fields resolve into a **parallel `custom_fields_resolved` block keyed by hash**, holding `name` and, where meaningful, `label`. `custom_fields` stays byte-identical with and without the flag. **Keying by hash rather than display name** dissolves the duplicate-display-name problem permanently — two custom fields sharing a display name cannot make the output unparseable.
- Resolvable types: `enum` / `set` (option label from the cached schema), `user` (cached list), `monetary` (`"12000.00 EUR"`), `address` (comma-joined). `date`, `varchar`, `text` and `double` get a `name` and no `label`. `person` / `organization` relations are the variable-cost half and land in ticket 12.
- **Resolved values are formatted neutrally** — no thousands separators, no locale decimal mark, no timezone conversion, no currency symbol substitution. The same record must produce the same bytes on a laptop and in CI.
- **`include_option_labels` is never sent**: it replaces the raw value rather than adding to it, and its coverage is partial.
- **Fixed-cost half:** at most four requests on a cold cache — the entity's field schema, `users`, `pipelines`, `stages` — and zero on a warm one.
- **Every failure degrades**: one `warning`, raw ids for the rest of the run, `resolved: "partial"`, exit 0. An ancillary lookup must never kill a forty-thousand-record walk that was otherwise perfect. The asymmetry with ticket 08 is deliberate: a `users` fetch failure degrades here and is fatal to `pd users list`.
- **`resolved` is `"off"` / `"partial"` / `"full"`, always present on every trailer.** ADR-0009 §10's `none` is a mis-citation; ADR-0008 wins. `partial` is what lets a caller detect that early records carry names and later ones do not.
- An unrecognised 40-character hex key forces **one** blocking schema refresh per schema per run; after that, unknown hashes are emitted raw with one `unknown_custom_field` warning.
- The warning kinds in play: `owner_resolution_unavailable`, `unknown_custom_field`.

- [x] `--resolve` adds all seven `*_name` siblings where resolvable, additively
- [x] Raw output is byte-identical with and without the flag, `custom_fields` included
- [x] An unresolvable id omits its sibling key entirely
- [x] `custom_fields_resolved` is keyed by hash and carries `name` plus `label` where meaningful
- [x] Two custom fields sharing a display name both resolve without collision
- [x] Money resolves as `"12000.00 EUR"` with no locale formatting, identically on any machine
- [x] `include_option_labels` is never sent
- [x] A cold cache costs at most four requests; a warm cache costs zero
- [x] Any resolution failure degrades: one warning, raw ids onward, `resolved: "partial"`, exit 0
- [x] `resolved` is `"off"` / `"partial"` / `"full"` on every trailer
- [x] An unrecognised hash forces exactly one schema refresh per schema per run, then one `unknown_custom_field` warning

## What shipped

`--resolve` now enriches live and cached resource records through the shared cache. Fixed lookups load only when projection retains their raw fields, put standard names and `custom_fields_resolved` immediately beside the raw values, and preserve the original values unchanged. Field schemas, users, pipelines and stages are validated through the same cached sources used by their own commands.

Enum, set, user, monetary and address labels are neutral and additive; legible scalar custom fields carry only their schema name. Unknown hashes trigger one forced schema refresh per run. Ancillary failures and surviving unknown hashes mark the trailer `partial`, warn once, and leave the primary walk successful. Person and organization relation names remain intentionally absent until ticket 12 supplies the variable-cost lookups.
