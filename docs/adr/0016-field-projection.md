# ADR-0016: Field projection, and what it is allowed to remove

Status: accepted
Date: 2026-08-12
Deciding ticket: [Field projection: shrinking output against an agent's context budget](../../.scratch/pd-cli-design/issues/25-grilling-field-projection.md)
Extends: [ADR-0009](0009-command-surface-and-manifest.md) — adds a ninth global flag, `--fields`, and one per-command section to the manifest
Extends: [ADR-0015](0015-stderr-and-run-diagnostics.md) §6 — adds `custom_fields` to the query-value allowlist
Confirms: [ADR-0002](0002-output-format.md), [ADR-0003](0003-pagination-bounding-and-partiality.md) — the trailer is unchanged and `emitted` still counts `record` lines
Corrects: this ticket's own premise about the upstream `include_fields` parameter — see §7

## Context

A 40,000-record walk emits every field of every record, and `--resolve` roughly doubles that. An
agent that wanted three fields pays for forty, in the one budget it cannot refill.

The counter-argument had to be answered first, because it is the reason this could have been no
flag at all: `jq` already trims JSON, and a flag that duplicates a tool the caller already has earns
nothing. It fails here for a specific reason. The agent does not read Pipedrive's response; it reads
**`pd`'s stdout**, and stdout is what lands in its context window. A `jq` filter downstream of `pd`
in a shell pipeline would work — but the agent harness invoking `pd` as a tool captures stdout
directly, and by then the tokens are spent. Trimming has to happen inside `pd` or not at all.

Three prior decisions fix what a projection is allowed to work with.

**ADR-0006 strips unknown keys**, so `pd`'s own record schema — not Pipedrive's release schedule —
defines the set of fields that can exist. The legal selector set is therefore knowable from `pd`'s
version alone, offline, before any request.

**ADR-0008 made resolution additive and parallel**: `custom_fields` is byte-identical with and
without `--resolve`, resolved values live in a hash-keyed `custom_fields_resolved` block, and seven
standard id fields gain `*_name` siblings. Every one of those is a second key holding the same fact
as a first key, which is the whole difficulty of this ADR.

**ADR-0003 counts `record` lines in `emitted`**, so a projection that only removes fields leaves the
trailer arithmetic untouched, and one that removes whole records would need a fourth subtractive
counter beside `skipped` and `duplicates`.

## Decision

### 1. `--fields` exists, and takes a comma-separated list

`--fields <name>[,<name>…]`, a global flag. Repeating it accumulates; duplicates are deduplicated
rather than rejected. No short form (ADR-0009), no negation syntax, no wildcards, no `--exclude`
inverse. One mode: name what you want.

**`id` is always emitted**, selected or not, along with the `type` and `record_type` envelope keys.
A record without an identity cannot be followed up, cannot be deduplicated, and would make the
`duplicates` counter unverifiable by the caller. It costs one small integer.

### 2. The selector language is top-level names, plus `custom_fields.<hash>`

Two forms and no others:

- a bare top-level field name — `title`, `value`, `org_id`, or `custom_fields` for the whole block
- `custom_fields.<hash>` for one custom field

No deeper dotting, no array indexing, no path expressions. The grammar stops here because `pd`'s
records are one level deep plus the custom-field block, and a path language sized for a shape that
does not exist is a permanent surface for no gain.

### 3. Custom fields are named by hash, never by display name

`--fields custom_fields.9a3f…c1`. A display name is not a legal selector.

ADR-0008 chose hash keys because display names collide, and Pipedrive does nothing to disambiguate
them. A projection accepting names would inherit that collision at exactly the wrong moment: a
caller asking for "Renewal date" and silently receiving a different field of the same name has no
way to notice. The objection that hashes are unusable by hand is real and answered by the surface
that already exists — `pd fields list --entity deals` prints hash and display name together, at zero
requests on a warm cache (ADR-0009 §"`pd fields list`"). The primary consumer looks the hash up; the
human runs one command first.

### 4. Resolution artifacts ride with their raw field and are never selected alone

The rule, stated once and applied to both cases ADR-0008 created:

> Selecting a raw field brings its resolution artifact along, when `--resolve` is on. The artifact is
> not independently selectable.

- `--fields custom_fields.9a3f…c1 --resolve` emits that hash in `custom_fields` **and** its entry in
  `custom_fields_resolved`. Selecting bare `custom_fields` brings the whole resolved block.
- `--fields org_id --resolve` emits `org_name` too. Same for the other six pairs of ADR-0008 §3.

`custom_fields_resolved`, `org_name` and its six siblings are **not legal selectors**; naming one is
a usage error (§6) whose message names the raw field to select instead.

The invariant this buys is the reason for the asymmetry: **the set of legal selectors does not
depend on `--resolve`.** The same `--fields` list is valid, and means the same thing, with and
without the flag — it just carries more or less with it. The rejected alternative, making artifacts
independently selectable, produces a flag combination that is silently empty: `--fields org_name`
without `--resolve` emits a record with nothing in it, and the caller sees a working command
returning blanks.

### 5. Projection removes fields, never records

`--fields` cannot drop a record. `emitted` continues to count every `record` line, `skipped` and
`duplicates` keep their meanings, and the trailer gains no field.

A record whose every selected field is absent still emits — as `{"type":"record","record_type":"deal","id":42}`.
That is information (the record exists, and has none of these fields), and suppressing it would make
`--fields` a filter that silently changes the answer to "how many deals are there".

Filtering is not this flag's job and not this ticket's; the search and filter surface is ticket 26's.

### 6. An unknown field name is a usage error; an unmatched hash is a warning

The two halves of the selector language can be checked at different times, so they are checked
differently.

**Top-level names are validated against `pd`'s record schema before any request**, and a name that
is not in it exits **2** with ADR-0001's `usage` error, listing the valid names for that command.
This is possible offline precisely because of ADR-0006: the schema is `pd`'s, not Pipedrive's.
Silent omission was rejected — a typo would produce plausible output with a field quietly missing,
and an agent cannot distinguish "field absent" from "field misspelled".

**A hash cannot be validated the same way.** Custom-field hashes are per-account and live in the
cache, which may be cold, so validating one could cost a request before the run starts. So any
syntactically valid hash is accepted, and if a selected hash matches **zero records across the whole
run**, the run ends with one deduplicated `warning` line, `kind: "unmatched_field_selector"`, naming
the hash. Deduplication by cause is ADR-0006's existing rule; this is a new `kind`, not a new
concept.

The asymmetry is deliberate and cheap to explain: a wrong name is always a mistake, a hash that
matched nothing might just be a field nobody filled in.

### 7. The upstream push-down is `custom_fields`, not `include_fields` — and it is invisible

**The ticket's premise was wrong, and checking the live v2 spec inverted it.** `include_fields` is
described as "*additional* data namespaces to include in response", enum-constrained per endpoint
(`next_activity_id`, `products_count`, `notes_count`, `ui_visibility`, …). It **adds** fields that
are otherwise absent. It cannot trim anything, so it is not a push-down target at all.

The genuine subtractive parameter is `custom_fields` — "comma separated string array of custom
fields keys to include… for faster results and smaller response", **maximum 15 keys**. Verified
present on eight operations covering four of ADR-0009's nine resources:

| resource | list | get |
| --- | --- | --- |
| deals | `getDeals`, `getArchivedDeals` | `getDeal` |
| persons | `getPersons` | `getPerson` |
| organizations | `getOrganizations` | `getOrganization` |
| products | `getProducts` | — |

`activities`, `pipelines`, `stages`, `users` and `fields` have no such parameter.

**`pd` pushes down when it can, and the caller cannot tell.** The parameter is sent when every
condition holds: the endpoint offers it, every custom-field selector is a hash, bare `custom_fields`
was not selected, and the count is ≤ 15. Otherwise `pd` fetches whole records and trims locally.

This is legitimate only because **output is byte-identical either way** — the pushed-down request
returns exactly the custom fields the projection would have kept. So the per-endpoint availability
the ticket worried about never reaches the contract: it changes response size and latency, not a
single emitted byte. It is an optimisation, and it is documented as one.

**`include_fields` is never sent, and its namespaces are outside `pd`'s record schema.** An agent
cannot select `notes_count`, because `pd` does not emit it. Adding one later is additive under
ADR-0014's semver rule and needs no `manifest_version` bump — but it would be a new field with an
upstream cost, not a projection question.

### 8. The manifest lists selectable fields per command

ADR-0009's manifest gains, per command, the list of selectable top-level field names.

Without it the flag is unusable by its primary consumer. An agent that cannot enumerate the fields
has exactly one way to learn them — run the command unprojected and read the output — which spends
precisely the context the flag exists to save. The manifest is fetched once and is per-version, so
it costs one small read against every subsequent run.

Custom-field hashes are **not** in the manifest: they are per-account, they change without a `pd`
release, and `pd fields list` already serves them. A command with no field list in the manifest
(`pd manifest`, `pd auth status`, `pd cache info` — the single-JSON-object commands) rejects
`--fields` as a usage error rather than ignoring it, which is the same rule as §6 and keeps
ADR-0009's flat flag table intact: the table says the flag exists, the manifest says where it
applies.

Adding this section is additive, so `manifest_version` does not move (ADR-0009 §9).

### 9. Key order is `pd`'s, except under `--pretty` where it is the caller's

In machine mode, emitted keys follow **`pd`'s schema order**, not the order the selectors were
written. Two callers selecting the same fields in different orders get byte-identical records, which
keeps ADR-0002's diffability property under projection.

Under `--pretty`, columns follow **selector order**, because a human writing `--fields title,value`
means it as a layout instruction, and ADR-0002 already declares `--pretty` unstable. Projection
otherwise applies to `--pretty` exactly as it does to NDJSON.

### 10. `custom_fields` joins ADR-0015 §6's query-value allowlist

`--verbose` prints query values only for an allowlist. `custom_fields` is added to it: its values are
per-account schema identifiers, not company data, and the whole point of logging it is to answer
"why is my field missing" by showing what was actually requested. `include_fields` is not added,
because §7 never sends it.

## Assumptions recorded rather than asked

Implementation-level, decided rather than put to the user, per the map's altitude rule.

- **Projection applies only to `record` lines.** `warning`, `error` and the trailer are untouched —
  a projection that could hide the error object would defeat ADR-0001.
- **Projection happens after zod validation, not before.** ADR-0006 validates the whole record;
  validating only the projected subset would let a malformed unselected field pass, and the same
  record would then validate differently depending on a display flag.
- **Projection happens before the resolve prefetch.** An unselected `org_id` needs no organization
  lookup, so projection shrinks ADR-0008 §9's `--resolve-budget` consumption as a side effect.
- **The 15-key ceiling is checked, not assumed.** Sixteen hash selectors fall back to local trimming
  silently; it is an optimisation, and a failed optimisation is not an error.
- **An empty hash set omits the parameter rather than sending it empty.** `--fields title,value`
  selects no custom fields at all and vacuously satisfies §7's conditions, so the rule needs pinning:
  `custom_fields=` with no value has undocumented semantics — plausibly "all", "none" or a 400 — and
  `pd` does not gamble on it. The parameter is sent only when at least one hash is selected;
  otherwise `pd` fetches whole records and drops the block locally. The byte-identical invariant is
  unaffected either way, so this decides only whether the optimisation fires, and it fires in the
  case that matters least. Whether an empty value in fact means "none" is worth probing once during
  implementation, because dropping every custom field from a 40,000-record walk is the single
  largest response-size win available.

## Consequences

- The flag surface reaches nine globals. `--fields` is an append; ADR-0009's flat table is unchanged
  in shape.
- **The largest context lever in the design is now in the caller's hands**, and it composes with
  ADR-0003's `--limit`: `--limit` bounds records, `--fields` bounds their width, and the two
  multiply.
- `AGENTS.md` gains the selector grammar, the "look the hash up with `pd fields list`" instruction,
  and the sentence that resolution artifacts ride with their raw field.
- **ADR-0015 §6's allowlist grows by one entry**, and the reasoning it established — structural
  parameters print, company data is redacted — is applied rather than reopened.
- **Ticket 26 inherits a boundary**: `--fields` is explicitly not a filter, so any record-dropping
  behaviour is that ticket's to invent, including whatever trailer field it needs.
- **Ticket 27 inherits a question this ADR deliberately does not answer**: if related-entity
  expansion adds a nested block to the record, the §2 grammar has no way to reach inside it. Either
  the block is selectable as a whole under its bare name, or ticket 27 extends the grammar — and
  extending it is a manifest-visible change.
- **Ticket 28 gains a cheap, high-value test**: the same projection with and without push-down must
  produce identical bytes. That is a property test against a recorded fixture, and it is the only
  thing standing between §7's optimisation and a silent contract change.
- The additive `include_fields` namespaces — activity counts, file counts, mail timestamps — are
  named as absent from `pd` rather than left unmentioned, so ticket 22 records a known gap instead of
  discovering it during implementation.
