# Custom field resolution mechanics

Type: grilling
Status: open

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
