# Custom fields, hash keys and enum option labels

Research for issue `03-research-custom-fields-and-option-labels.md`. Primary sources only:
Pipedrive's own OpenAPI specs and developers.pipedrive.com / pipedrive.readme.io documentation.
No live API calls were made. Both specs were downloaded as static files.

Spec sources used throughout:

- **v2 spec**: <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml> (`info.title: Pipedrive API v2`, `version: 2.0.0`, server `https://api.pipedrive.com/api/v2`)
- **v1 spec**: <https://developers.pipedrive.com/docs/api/v1/openapi.yaml> (`info.title: Pipedrive API v1`, `version: 1.0.0`)

Line references below are into those downloaded files as of 2026-08-11.

---

## 1. Which endpoints expose the field schema, and at which API version

### Present in v2

All of these are `GET`, cursor-paginated, and cost **10 tokens** per call (`x-token-cost: 10`).
Source: v2 spec, path list and per-path `x-token-cost`.

| Endpoint | v2 path | Token cost | Also has |
| --- | --- | --- | --- |
| Activity fields | `GET /activityFields` | 10 | `/activityFields/{field_code}` (read-only, no options endpoint) |
| Deal fields | `GET /dealFields` | 10 | `/dealFields/{field_code}`, `/dealFields/{field_code}/options` |
| Person fields | `GET /personFields` | 10 | `/personFields/{field_code}`, `.../options` |
| Organization fields | `GET /organizationFields` | 10 | `/organizationFields/{field_code}`, `.../options` |
| Product fields | `GET /productFields` | 10 | `/productFields/{field_code}`, `.../options` |
| Project fields | `GET /projectFields` | 10 | `/projectFields/{field_code}`, `.../options` |

The `/{field_code}/options` endpoints are **write-only in practice** for this tool's purposes — the v2 spec
defines only `POST`, `PATCH` and `DELETE` on them (add / update / delete options in bulk), no `GET`.
Option labels are therefore read exclusively from the list endpoint's `options[]` array.
Source: v2 spec, `'/dealFields/{field_code}/options'` — `post: Add deal field options in bulk`,
`delete: Delete deal field options in bulk`.

The changelog announcing this API confirms the entity coverage: "full CRUD operations for deal, person,
organization, and product fields, along with bulk options management for enum and set field types",
with Activity Fields read-only.
Source: <https://developers.pipedrive.com/changelog/post/introducing-new-fields-api-v2>

### v1-only — CRITICAL FINDING

| Endpoint | v1 path | Token cost | v2 equivalent |
| --- | --- | --- | --- |
| Lead fields | `GET /leadFields` | 20 | **none** |
| Note fields | `GET /noteFields` | 20 | **none** |

Source: v1 spec path list contains `/activityFields`, `/dealFields`, `/leadFields`, `/noteFields`,
`/organizationFields`, `/personFields`, `/productFields`. The v2 spec path list contains no `leadFields`
and no `noteFields`. The Fields API v2 changelog lists only five entity types and does not mention leads
or notes: <https://developers.pipedrive.com/changelog/post/introducing-new-fields-api-v2>

**The gap is wider than the field schemas.** In v2 there is also no list endpoint for the entities themselves:

- v2 has only `/leads/search`, `'/leads/{id}/convert/deal'`, `'/leads/{id}/convert/status/{conversion_id}'`.
  There is **no `GET /leads` list** in v2. v1 has `/leads`, `/leads/archived`, `/leads/search`.
- v2 has **no `/notes` at all**. v1 has `/notes`.

Source: v2 spec path list vs v1 spec path list.

**Consequence for `pd`**: if the command surface is to cover leads or notes at all — and the issue text
lists both — then **v1 support is mandatory, not optional**. The generated client (locked decision 2 in
`map.md`, generated from the v2 spec) cannot reach leads-as-a-list or notes. This is a decision the spec
must resolve explicitly: either drop leads and notes from scope, or generate a second client from the v1
spec and accept two field-definition shapes (see §2).

### No `v2` field schema for Leads — what leads actually use

The v1 `LeadFields` tag says leads have their own near-complete schema, worded identically to `DealFields`:

> "Lead fields represent the near-complete schema for a lead in the context of the company of the authorized
> user. Each company can have a different schema for their leads, with various custom fields."

Source: v1 spec, `tags` → `name: LeadFields`, description.

Whether that set is literally the deal custom field set is **not stated** — see Open questions.

---

## 2. The exact shape of a field definition

### v2 shape

Source: v2 spec, `GET /dealFields` → `responses.200` schema and its inline `example`.
The other five `*Fields` endpoints share this shape.

Required properties: `field_name`, `field_code`, `field_type`, `is_custom_field`, `is_optional_response_field`.

```yaml
field_name:    string   # "The display name/label of the field"
field_code:    string   # "The unique identifier for the field (40-character hash for custom fields)"
description:   string
field_type:    string   # enum, see below
options:       array|null   # "Array of available options for enum/set fields, null for other field types"
  - id:          integer | string  # "integer for custom fields, string for built-in fields"
    label:       string            # "The option display label"
    color:       string|null
    update_time: date-time|null    # "When the option was last updated"
    add_time:    date-time|null
subfields:     array|null   # "Array of subfields for complex field types (address, monetary),
                            #  null for simple field types"
  - field_code: string
    field_name: string
    field_type: string
is_custom_field:            boolean  # "Whether this is a user-created custom field"
is_optional_response_field: boolean  # "Whether this field is not returned by default in entity responses"
ui_visibility:    object   # only when requested via include_fields
important_fields: object   # only when requested via include_fields
required_fields:  object   # only when requested via include_fields
```

Verbatim example from the v2 spec (`GET /dealFields` → `example`), showing a plain field and a
monetary field with its subfields:

```json
{
  "success": true,
  "data": [
    {
      "field_name": "Deal Title",
      "field_code": "title",
      "description": "The title or name of the deal",
      "field_type": "varchar",
      "options": null,
      "subfields": null,
      "is_custom_field": false,
      "is_optional_response_field": false
    },
    {
      "field_name": "Value",
      "field_code": "value",
      "description": "The monetary value of the deal",
      "field_type": "monetary",
      "options": null,
      "subfields": [
        { "field_code": "value",    "field_name": "Amount of Value",   "field_type": "double" },
        { "field_code": "currency", "field_name": "Currency of Value", "field_type": "varchar" }
      ],
      "is_custom_field": false,
      "is_optional_response_field": false
    }
  ],
  "additional_data": { "next_cursor": null }
}
```

`field_type` enum in v2 (`GET /dealFields`):
`int`, `double`, `boolean`, `varchar`, `text`, `phone`, `varchar_options`, `varchar_auto`, `date`,
`daterange`, `time`, `timerange`, `enum`, `set`, `address`, `monetary`, `deal`, `deals`, `lead`, `org`,
`people`, `project`, `stage`, `user`, `activity`, `json`, `picture`, `status`, `visible_to`, `price_list`,
`billing_frequency`, `projects_board`, `projects_phase`.

### v1 shape — different property names

Source: v1 spec, `GET /dealFields` → `responses.200` → `data.items` (`title: Field`).

```yaml
id:                     integer|null  # "null in case of subfields"
key:                    string        # "For custom fields this is generated upon creation"
name:                   string
order_nr:               integer
field_type:             string
add_time:               date-time     # "The creation time of the field"
update_time:            date-time|null # "The update time of the field"
last_updated_by_user_id: integer|null
created_by_user_id:     integer|null
active_flag:            boolean
edit_flag:              boolean
bulk_edit_allowed:      boolean
searchable_flag:        boolean
filtering_allowed:      boolean
sortable_flag:          boolean
mandatory_flag:         boolean
options:                array|null    # "When there are no options, null is returned."
options_deleted:        array         # "Only present when there is at least 1 deleted option."
is_subfield:            boolean       # "Only present if field is subfield."
subfields:              array         # "Only present when the field has subfields."
```

The rename is confirmed by the migration guide: `key` → `field_code`, `name` → `field_name`,
`edit_flag` → `is_custom_field`; and the path changed from `/api/v1/dealFields/:id` to
`/api/v2/dealFields/:field_code`.
Source: <https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide>

**Implication**: if `pd` must call `leadFields` / `noteFields` (v1-only) alongside the v2 endpoints, it has to
normalise two different field-definition shapes into one internal model.

---

## 3. Every field type whose stored value is not the displayed value

All JSON below is quoted from the v2 migration guide unless noted.
Source: <https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide>

In **v2** all custom fields are nested under a `custom_fields` object on the entity, not at the root:

```json
"custom_fields": { "field_key": "value" }
```

> "An object where each key represents a custom field. All custom fields are referenced as randomly generated
> 40-character hashes."

Source: v2 spec, `GET /deals` → `data.items.custom_fields` description (identical wording on `GET /persons`).

### Single option (`enum`) — stored as the numeric option id

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": 123
}
```

Resolution needs `options[]` from the matching `*Fields` endpoint: `123` → `label`.

### Multiple options (`set`) — stored as an array of numeric option ids

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": [123, 456]
}
```

In **v1** the same value is a **comma-separated string of option ids at the entity root**, not an array and
not nested. Verbatim from Pipedrive's own tutorial, showing a product with a multiple-options custom field:

```json
{
  "success": true,
  "data": {
    "id": 789,
    "name": "Batmobile",
    "576da0ff55f3635ae48bfe1416854dfc2d3c692a": "11,12"
  }
}
```

Source: <https://developers.pipedrive.com/tutorials/update-custom-field-pipedrive-api>

The same tutorial shows the v2 write form as an array (`[11, 12]`) nested under `custom_fields`, matching the
migration guide. The label field follows the identical v1→v2 pattern (`"2,3"` → `[3, 7]`, see below), so a
v1 reader must split on `,` and coerce to numbers for every `set` field and for `label`.

Note for completeness, though `pd` is read-only: "For multi-option fields (field type `set`), use `null` to
clear the selection — sending an empty array `[]` is not supported and will result in a validation error."
Source: v2 spec, `custom_fields` property description on `GET /deals`.

### Monetary — object with `value` and `currency` in v2, sibling key in v1

v2:

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": { "value": 500, "currency": "USD" }
}
```

v1 stores a **separate sibling key** at the entity root:

> "if there is a monetary field with the key `ffk9s9` stored on the account, `ffk9s9` would hold the numeric
> value of the field, and `ffk9s9_currency` would hold the ISO currency code that goes along with the numeric
> value. To find out which data fields are available, fetch one deal and list its keys."

Source: v1 spec, `tags` → `name: DealFields`, description. The identical sentence appears under `LeadFields`.
The same `_currency` suffix is documented at
<https://pipedrive.readme.io/docs/core-api-concepts-custom-fields>.

Critically, the v1 tag text also says the sibling key is **not itself a field in the schema response**:

> "some types of custom fields can have additional data fields which are not separate deal fields per se.
> Such is the case with monetary, daterange and timerange fields – each of these fields will have one
> additional data field in addition to the one presented in the context of deal fields."

So a v1 consumer that resolves record keys purely by matching against `GET /dealFields` will be left with an
unresolvable `<hash>_currency` / `<hash>_until` key. v2's `subfields[]` array fixes exactly this.

### Date range (`daterange`) — `value` + `until`

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": { "value": "2024-01-01", "until": "2024-02-01" }
}
```

v1: sibling key `<hash>_until` (per the v1 `DealFields` tag text above).

### Time range (`timerange`) — `value` + `until` + `timezone_name`

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": {
    "value": "09:00:00",
    "until": "11:00:00",
    "timezone_name": "Europe/London"
  }
}
```

This is the only custom field type that carries a timezone in its value. It matters for the
"Value formatting" open item in `map.md`.

### Address — object with `value` plus Google-style subfields

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": {
    "value": "530 Fifth Avenue, New York, NY, USA",
    "street_number": "530",
    "route": "5th Avenue",
    "country": "United States"
  }
}
```

The full subfield vocabulary documented for address fields is: `country`, `formatted_address`, `locality`,
`sublocality`, `type`, `subpremise`, `route`, `street_number`, `admin_area_level_1`, `admin_area_level_2`,
`postal_code`, `value`.
Source: <https://pipedrive.readme.io/docs/webhooks-v2-migration-guide>

> "Only the value subfield is required when updating an address field. All other address subfields are
> optional and will default to null if not provided."

Source: <https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide>

Which subfields are actually present on a given record is therefore variable — `pd` must treat every
address subfield as optional.

### User / Organization / Person relation fields — bare numeric id

```json
"custom_fields": {
  "d4de1c1518b4531717c676029a45911c340390a6": 1234
}
```

Resolving `1234` to a display name requires a **separate request to another entity endpoint** — there is no
option list to consult. This is the one non-displayed value class that the field schema cache cannot answer,
and it interacts directly with the "Related-entity expansion" open item in `map.md`.

### Labels — `label` string in v1 became `label_ids` array in v2

> **v1:** `"label": "2,3"`
> **v2:** `"label_ids": [3, 7]`

Source: <https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide>

Confirmed in the v2 spec's `GET /persons` example: `label_ids: [1, 2, 3]`.

Label ids resolve through the same field-schema endpoints — the label field is itself an options field:

| Entity | Endpoint | Returns |
| --- | --- | --- |
| Deals | `GET /dealFields` | options with `id`, `label`, `color` |
| Persons | `GET /personFields` | options with `id`, `label`, `color` |
| Organizations | `GET /organizationFields` | options with `id`, `label`, `color` |
| Leads | `GET /leadLabels` (v1) | labels with `id` (UUID string), `name`, `color` |

Source: <https://pipedrive.readme.io/docs/working-with-labels>

Note the inconsistency: lead labels use `name`, not `label`, and their ids are UUID strings such as
`"5e5faf00-b6e0-11ea-b5f6-45d1bda97e35"`, not integers.

### Phone and email — labelled arrays, and they are NOT custom fields

On persons these are first-class root-level properties, not entries in `custom_fields`.
Verbatim from the v2 spec `GET /persons` example:

```json
"emails": [
  { "value": "email1@email.com", "primary": true,  "label": "work" },
  { "value": "email2@email.com", "primary": false, "label": "home" }
],
"phones": [
  { "value": "12345", "primary": true,  "label": "work" },
  { "value": "54321", "primary": false, "label": "home" }
],
"im": [
  { "value": "skypeusername",    "primary": true,  "label": "skype" },
  { "value": "whatsappusername", "primary": false, "label": "whatsapp" }
]
```

Source: v2 spec, `GET /persons` → `example`.

Note the v2 property names are **plural** (`emails`, `phones`); v1 uses singular `email` / `phone`.
The `label` here is a free-text classification string ("work", "home"), already human-readable — it does
**not** need option resolution. A `phone`-typed **custom** field is different: it is a plain string value
(`varchar`-like), not an array.

`im` is documented as "included if contact sync is enabled for the company" — as are `notes`, `birthday`
and `job_title`. Their presence is account-dependent.
Source: v2 spec, `GET /persons` → `data.items` property descriptions.

---

## 4. The shortcut: `include_option_labels` — Pipedrive resolves enum/set for you

The v2 entity endpoints accept a query parameter that makes option resolution unnecessary:

> `include_option_labels` — "When provided with a 'true' value, single option and multiple option custom
> fields values contain objects in the form of '{ id: number, label: string }' instead of plain id"

> `include_labels` — "When provided with 'true' value, response will include an array of label objects in the
> form of '{ id: number, label: string }'"

Source: v2 spec, query parameters on `GET /deals`.

**Coverage is partial.** Both parameters exist only on:

- `GET /deals`, `GET /deals/archived`, `GET /deals/{id}`
- `GET /persons`, `GET /persons/{id}`
- `GET /organizations`, `GET /organizations/{id}`

They are **absent** from `GET /activities`, `GET /products`, `GET /projects`, `GET /tasks` and every
`/search` endpoint.
Source: v2 spec — grep for `include_option_labels` returns matches under those six path/operation blocks only.

This is a real design fork for `pd`'s `--resolve`-style flag:

- **Server-side** (`include_option_labels=true`): zero extra requests, zero cache, correct by construction —
  but only for deals, persons, organizations, and only for enum/set/labels. It does **not** resolve the hash
  key itself into `field_name`, which is the larger half of the readability problem.
- **Client-side** (fetch `*Fields`, build a map): works for every entity, resolves hash → name as well as
  option id → label, costs a cached schema fetch.

The hash-to-name mapping has no server-side equivalent, so a client-side schema cache is required regardless.
`include_option_labels` can at best save the option half of the work on three entity types.

Related, and useful for the "Field projection" open item: `GET /deals` also takes

> `custom_fields` — "Optional comma separated string array of custom fields keys to include. If you are only
> interested in a particular set of custom fields, please use this parameter for faster results and smaller
> response. A maximum of 15 keys is allowed."

Source: v2 spec, `GET /deals` query parameters. Note the hard cap of 15 keys.

---

## 5. Can two custom fields on the same entity share a display name?

**No documented uniqueness constraint exists.** Neither spec declares `field_name` / `name` unique, and no
documentation page states that Pipedrive rejects a duplicate name.

What the documentation *does* say is a warning about exactly this hazard:

> "This can cause issues where the field names match, but the API keys do not because one has a Pipedrive API
> key and the other has a 40-character hashed API key."

Source: <https://pipedrive.readme.io/docs/core-api-concepts-custom-fields>

That passage is about Contact Sync fields (which use readable underscore keys) colliding by name with
user-created custom fields (40-character hashes) — so at minimum, **a name collision between a built-in/sync
field and a custom field is documented as possible**, and Pipedrive does nothing to disambiguate it beyond
warning integrators.

**Practical conclusion for `pd`**: treat `field_name` as non-unique. A resolution layer keyed on display name
is unsafe. Only `field_code` is guaranteed unique — it is described as "The unique identifier for the field"
(v2 spec, `GET /dealFields`). If resolved output uses names as JSON object keys, the tool needs a
deterministic disambiguation rule of its own (for example, appending a short prefix of the hash on collision),
because Pipedrive supplies none.

---

## 6. Staleness detection for a field-schema cache

| | v1 | v2 |
| --- | --- | --- |
| Field-level `add_time` | yes | **no** |
| Field-level `update_time` | yes (nullable) | **no** |
| `last_updated_by_user_id` | yes | no |
| Option-level `add_time` / `update_time` | not in the typed schema (`options` is `array of object`, untyped) | **yes**, on each option |
| Deleted options | `options_deleted` array, "Only present when there is at least 1 deleted option" | not present |

Sources: v1 spec `GET /dealFields` → `Field` schema; v2 spec `GET /dealFields` → response schema.

**This is an awkward regression for cache design.** In v2 a field definition carries no version or timestamp
of its own. Only its `options[]` entries do. So:

- There is no cheap "has the schema changed?" probe. Detecting staleness means re-fetching the whole schema
  and diffing it — which costs the same as just refreshing it.
- A renamed field (`field_name` changed, no option change) is invisible to any timestamp-based check in v2.
- v2 also drops `options_deleted`, so a record holding a since-deleted option id will resolve to nothing.
  The resolver must tolerate an unresolvable option id rather than treating it as an error.

There is no ETag / `If-None-Match` support documented on these endpoints in either spec.

The practical cache policy therefore has to be time-based (a TTL) plus an explicit `--no-cache` bypass,
which `map.md` already locks in as a flag.

---

## 7. Cost of a full field-schema fetch

Per entity type, v2:

- **10 tokens** per request (`x-token-cost: 10`).
- `limit` default 100, "a maximum value of 500 is allowed".
- Cursor pagination: `additional_data.next_cursor`, "null if no more pages".

Source: v2 spec, `GET /dealFields` parameters and response.

So one entity type = `ceil(field_count / 500)` requests. For any realistic account that is **1 request /
10 tokens**. Covering the five v2 entities `pd` is likely to read (deal, person, organization, activity,
product) is **5 requests / 50 tokens**, once, cached.

v1 costs **double**: `x-token-cost: 20` on `GET /dealFields`, `GET /leadFields`, `GET /noteFields`,
and v1 uses offset pagination (`start` / `limit`, `additional_data.more_items_in_collection`) rather than
cursors. Adding leads and notes means +2 requests / +40 tokens.
Source: v1 spec, respective paths.

Note the v2 `*Fields` endpoints are cursor-paginated like everything else in v2, so locked decision 5 in
`map.md` ("pagination is complete and correct by default") applies to schema fetches too — a schema fetch is
not a single-request special case in the client module.

---

## Open questions / not documented

1. **Do leads reuse the deal custom field schema, or their own?** v1 has a distinct `GET /leadFields`, and its
   tag text mirrors `DealFields` word for word without saying whether the two return the same custom fields.
   No page found states the relationship explicitly. Resolving this decides whether lead support needs one
   extra v1 call or can reuse the cached deal schema.
2. **Are `leadFields` / `noteFields` planned for v2, and is v1 sunset-dated?** The Fields API v2 changelog
   gives no deprecation notice and no sunset date, and lists only five entity types. Whether v1 will remain
   available for leads and notes indefinitely is unstated. This is the single biggest unknown behind the
   "must `pd` speak v1?" decision.
3. **Can two *custom* fields on one entity have byte-identical display names?** Documentation warns about
   built-in-vs-custom name collisions but never addresses custom-vs-custom, and neither spec marks the name
   unique. Cannot be settled without a live account (deliberately not used here).
4. **Maximum custom field count per entity.** Not stated in either spec or in the custom fields guide. Options
   are capped at 10,000 per field (source: custom fields guide), but the number of fields is not documented,
   so whether a schema fetch can ever exceed one page of 500 is unknown. The client must page anyway.
5. **Are `options[]` ever truncated in the list response?** The existence of dedicated
   `/{field_code}/options` endpoints hints that very large option sets (up to 10,000) might be paginated or
   trimmed on the list endpoint, but the v2 spec declares no `options` pagination and the options endpoints
   expose no `GET`. If they are truncated, there is currently **no documented read path** to fetch the
   remaining options. Unverified and potentially significant for `enum`/`set` fields with many options.
6. **Stored value shape of the `phone` custom field type.** The migration guide's type-by-type JSON list does
   not include a `phone` example. The custom fields guide describes it as a phone number or Skype name string.
   Assumed to be a plain string, not the labelled array used by the built-in `phones` property — assumption,
   not a citation.
7. **Stored shape for the v2-only field types** `deals`, `stage`, `project`, `activity`, `status`,
   `price_list`, `billing_frequency`, `projects_board`, `projects_phase`, `picture`, `json`,
   `varchar_options`. These appear in the v2 `field_type` enum but in no documented value example. Most are
   presumably bare ids like the other relation types, but `deals` (plural) and `varchar_options` are not
   guessable.
8. **Behaviour of `include_option_labels` against a deleted option id.** Undocumented — unclear whether the
   API returns `{id, label: null}`, the bare id, or omits the field.
9. **`is_optional_response_field`.** v2 marks fields "not returned by default in entity responses" but does
   not document the parameter that opts them in per entity, beyond the per-endpoint `include_fields`
   enumerations. Worth checking against `GET /deals`' own `include_fields` list before designing projection.
10. **Rate/token behaviour of a burst of five schema fetches.** Covered by the separate rate-limits research
    ticket; noted here only because a cold-cache `pd` run issues them back to back.
