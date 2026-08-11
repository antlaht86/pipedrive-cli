# Cache design: what, where, keyed how, invalidated when

Type: grilling
Status: resolved

Blocked by: 01, 09

## Question

`--no-cache` is locked, so a cache exists. Define it.

- What is cacheable. Field schemas and option labels are near-static and expensive; individual records are volatile; whole paginated result sets are large and stale fast. Draw the line and justify it.
- The key. Endpoint plus parameters plus company account plus API version, at least — and the account matters because one machine may hold credentials for more than one. Does the credential itself, or a hash of it, belong in the key?
- TTL, and whether it differs by what is cached. A field schema changing hourly is implausible; a deal changing hourly is routine.
- Invalidation beyond TTL: whether Pipedrive offers anything (an ETag, a modification timestamp, an update-time filter) that beats guessing, per ticket 03's findings.
- On-disk location, and how it interacts with ticket 21's distribution choice and ticket 20's credential store. A cache that lands next to the binary is wrong.
- Whether a cached read counts against `--max-requests`. Argue both: counting makes the ceiling a predictable cost bound; not counting makes it a bound on real API load, which is what the shared budget actually cares about. The answer changes what `--max-requests` means.
- Cache corruption and concurrent access: two `pd` processes writing the same entry, a half-written file, a schema change between versions.
- Whether a credential or any record data in the cache needs protecting on disk.
- Whether the cache can be inspected or cleared, given the read-only surface — is `pd cache clear` a write operation?

Record as an ADR.

## Answer

Full detail in [ADR-0005](../../../docs/adr/0005-cache-design.md).

The cache holds a **closed list of five** resources — `users`, `dealFields`, `personFields`,
`organizationFields`, `productFields` — and nothing else. No entity records, no result sets: an agent
cannot tell a stale deal from a fresh one, so the cache is confined to data an admin edits by hand.
`activityFields`, `leadFields` and `noteFields` are deliberately outside the list and cost one request
per invocation to resolve.

The key is the **first 16 hex characters of SHA-256 over the resolved API token**, which supersedes
research 08's suggestion that the profile name key the field cache. A profile name is not an account
identity, and repointing `default` at another company would mislabel custom field hashes with no error
anywhere. Keying by credential removes that failure at zero request cost; the price is that a token
rotation discards a warm cache.

TTL is **24 h for schemas, 1 h for `users`**, and an **unrecognised 40-character hash — or an unknown
`owner_id` — forces one refresh** regardless of the clock. Without that, a field added at 10:00 renders
as a raw hash all day and the agent has no reason to reach for `--no-cache`, because it does not know
the field exists.

**A cache hit does not count against `--max-requests`**: the flag bounds requests that reach the
network, because it exists to protect the shared budget and the burst window, neither of which a disk
read touches.

A **broken entry is skipped, refetched, and reported as a `warning` line** — silent skipping would let
an unwritable cache directory drain the shared budget forever with no signal. Storage is
`~/.cache/pd/<token-hash>/`, `0600`, temp-file plus `rename`, version-stamped, no locks.

**`pd cache info` and `pd cache clear` exist**, both with zero HTTP requests; `clear` takes no argument
that could widen its constant target. Read-only is a property of the Pipedrive API surface, not of the
local filesystem.

**`--no-cache` skips the read and still writes**, so one run repairs a stale entry instead of the flag
becoming permanent.

Open dependency: `users` is a Class B v1-only resource (research 04), so its caching is inert until
ticket 18 delivers a v1 client, and it costs 20 tokens per list rather than 10.
