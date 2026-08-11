# Custom fields, hash keys and enum option labels

Type: research
Status: resolved

## Question

What does it take to turn a Pipedrive record full of 40-character hash keys into readable output?

- Which endpoints expose the field schema per entity type (deals, persons, organizations, activities, products, notes, leads), what each returns, and whether they are v1 or v2.
- The exact shape of a field definition: hash key, human name, type, and for enum and set fields the option id to label mapping.
- Every field type whose stored value is not the displayed value — single option, multiple options, user, org, person, monetary with its currency sibling, date range, time range, address with its subfields, phone and email with their labelled arrays.
- How a set or multi-option value is stored on the record.
- Whether two custom fields on the same entity can share a display name, and whether Pipedrive itself does anything to disambiguate.
- Whether field definitions carry a modification timestamp or version that a cache could use to detect staleness.
- How many requests a full field-schema fetch costs per entity type.

This is the factual basis for the custom field resolution decision.

## Answer

Findings: [research/03-custom-fields-and-option-labels.md](../research/03-custom-fields-and-option-labels.md).

**Pipedrive can resolve enum and set options for us.** The v2 entity endpoints accept `include_option_labels`, which returns single- and multi-option custom field values as `{ id, label }` objects instead of bare numeric ids, and `include_labels` for label arrays. **Coverage is partial** — the parameters exist only on some endpoints — so a client-side mapping is still needed as the general path. This materially changes the custom field resolution decision: part of the problem may not be ours to solve.

Field schemas live in **v2** for deals, persons, organizations, products and activities. Only `leadFields` and `noteFields` are v1-only. The single-field path parameter renamed from `{id}` to `{field_code}` in v2.

Many field types store something other than what is displayed: single option and set (numeric ids), monetary (`value` + `currency`, an object in v2 but a sibling key in v1), date range and time range (`value` + `until`, plus `timezone_name`), address (an object with Google-style subfields), user/org/person relations (bare numeric ids), and labels (`label` string in v1 became a `label_ids` array in v2). Phone and email are labelled arrays and are **not** custom fields.

**Duplicate display names are possible and undocumented.** No uniqueness constraint is declared anywhere. Pipedrive's own documentation warns about exactly this hazard for Contact Sync fields colliding by name with user-created custom fields, and does nothing to disambiguate them.
