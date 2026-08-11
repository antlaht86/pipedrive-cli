# Cache design: what, where, keyed how, invalidated when

Type: grilling
Status: open

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
