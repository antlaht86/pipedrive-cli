# 08 — Cache and the four cached resources

**What to build:** An agent runs `pd fields list --entity deal` and learns the account's custom-field hashes beside their display names, without walking a single record. It runs `pd users list`, `pd pipelines list`, `pd stages list`. On a second run within the TTL the same commands report `requests: 0`. An operator runs `pd cache info` and sees the path, the entries and their ages; `pd cache clear` empties it.

**Blocked by:** 05

**Status:** ready-for-agent

Normative: ADR-0005 (cache design), ADR-0007 (the narrow v1 users client), ADR-0009 (command surface).

## The closed list — eight entries and nothing else

| Entry | TTL |
| --- | --- |
| `users` | 1 h |
| `dealFields`, `personFields`, `organizationFields`, `productFields`, `activityFields` | 24 h |
| `pipelines`, `stages` | 24 h |

The rule is: **every v2 `*Fields` schema is cached for 24 hours.** `projectFields` is excluded only because projects have no command surface. **No entity records, no result sets, no search results, ever.**

Notes for the implementer:

- Keyed by **credential**: `$XDG_CACHE_HOME/pd/<token-hash>/`, default `~/.cache/pd/`, `%LOCALAPPDATA%\pd\<token-hash>\` on Windows. `<token-hash>` is the first 16 hex of SHA-256 of the resolved token — the same value `pd auth status` reports. Keying by a user-invented profile name would silently poison a repointed credential's cached schemas.
- Mechanics: temp file plus `rename`, mode `0600`, a schema version per entry (an **unrecognised version is treated as missing**), and **no credential is ever written** into a cache file.
- **A cache hit does not count against `--max-requests`**, which is therefore a count of *network* requests.
- A broken entry is skipped, refetched, and reported as a `cache_entry_skipped` warning — on stdout in machine mode, on stderr under `--pretty`. **Never fatal, never silent.** Cache corruption is not an error variant: `pd` evicts and refetches.
- **Cached data is validated on read** in the same two stages against the **same** record schema, so `--no-cache` cannot change what `pd` accepts.
- `--no-cache` skips the **read** and still **writes**, so one run restores the normal path.
- `pd cache clear` takes **no path argument, no pattern and no widening flag**.
- `pd users list` reads through the narrow v1 client — the single generated `GET /users` operation. **A `users` fetch failure is fatal here**, because the list is the answer rather than a decoration. (Under `--resolve` the same failure degrades; that asymmetry is deliberate and lands in ticket 11.)
- For the four cached resources, **`get` filters the cached list** and reports `requests: 0` on a warm cache.
- `fields` is the one resource whose id is not an integer: `pd fields get --entity deal <field_code>`. `pd fields list --entity <name>` **requires** `--entity`, one of `deal`, `person`, `organization`, `product`, `activity`; omitting it is exit 2.
- `pd cache info` and `pd cache clear` sit **outside the grammar** — they are named exceptions, not resources. Their stdout is a single JSON object, not NDJSON.
- Read-only is scoped to the **Pipedrive API**: `pd cache clear` deletes local files and that is not a violation.

- [ ] The eight entries cache with their stated TTLs and nothing else is ever cached
- [ ] The cache directory is keyed by the first 16 hex of SHA-256 of the token, on POSIX and Windows paths
- [ ] Entries are written temp-plus-rename at mode `0600` and carry a schema version; an unrecognised version reads as missing
- [ ] No credential string is ever written into a cache file
- [ ] A warm cache reports `requests: 0` and a cache hit does not count against `--max-requests`
- [ ] A corrupt entry produces one `cache_entry_skipped` warning, refetches, and never fails the run
- [ ] Cached data is revalidated on read against the same record schema
- [ ] `--no-cache` skips the read and still writes
- [ ] `pd users list`, `pd pipelines list`, `pd stages list` and `pd fields list --entity <name>` all work
- [ ] `pd fields list` without `--entity` is exit 2, and `pd fields get --entity deal <field_code>` takes a non-integer id
- [ ] `get` on a cached resource filters the cached list at zero requests
- [ ] A `users` fetch failure is fatal to `pd users list`
- [ ] `pd cache info` reports path, entries and ages; `pd cache clear` accepts no argument, pattern or flag
