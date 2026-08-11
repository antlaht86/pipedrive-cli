# ADR-0005: The cache — what it holds, how it is keyed, and when it is wrong

Status: accepted
Date: 2026-08-11
Supersedes in part: the cache-keying suggestion in research 08

## Context

`--no-cache` is a locked flag, so a cache exists. What it holds was never decided.

Two facts fix the shape of the answer. First, the Pipedrive daily token budget is shared across the
whole company account, so every avoided request is budget left for a colleague's integration. Second,
`pd`'s consumer is an agent that does not read stderr and cannot tell fresh data from stale data by
looking at it. A cache that silently serves an old answer is therefore a worse failure than a cache
that is never used at all.

Research 03 found no ETag, no `If-Modified-Since` support and no modification timestamp on the field
schema endpoints. Freshness cannot be negotiated with the server; it can only be guessed from a clock
or inferred from the data.

## Decision

### 1. A closed list of five cacheable resources

The cache holds exactly these, and nothing else:

- `users`
- `dealFields`
- `personFields`
- `organizationFields`
- `productFields`

No entity records. No paginated result sets. No search results. No `/users/me` response.

The list is closed, not a rule. It is deliberately not "every `*Fields` endpoint": `activityFields`,
`leadFields` and `noteFields` are fetched fresh on every invocation. The consequence is an
asymmetry the caller can measure — `pd deals list --resolve-fields` pays for its schema once a day,
`pd activities list --resolve-fields` pays for it on every run. That cost is accepted in exchange for
a cache surface small enough to reason about in full.

Entity records are excluded on the freshness argument above. A deal changes hourly, and an agent
asking for a deal is asking what is true now. Result sets are excluded for the same reason plus size:
a 40,000-record walk is not a cache entry, and caching one would make ADR-0003's `complete` marker a
statement about the disk rather than about Pipedrive.

**Assumption, stated because it is a dependency and not a decision**: `users` is a Class B v1-only
resource per research 04, so caching it presupposes ticket 18 ships a second generated client against
v1. Until then the `users` entry is simply never populated and every path that needs it degrades to
"no owner names". v1 also costs double — a list is 20 tokens against v2's 10 — which is the real
arithmetic behind the hourly TTL below: roughly 480 tokens a day per active machine, not 240.

### 2. The key is a hash of the credential

A cache directory is `~/.cache/pd/<token-hash>/`, where `<token-hash>` is the first 16 hex characters
of the SHA-256 of the resolved API token.

**This supersedes research 08's suggestion that the profile name keys the custom-field cache.** The
profile name is a string the user invents; it is not an account identity. Repointing `default` at a
different Pipedrive company silently poisons every cached field schema, and the symptom is not an
error — custom field hashes are per-account, so `--resolve-fields` labels `9a3f…` with the wrong name
or fails to label it, and the output looks entirely normal. Keying by the credential makes that
failure impossible by construction, at no request cost. Verifying the account instead (`GET /users/me`,
2 tokens) would spend exactly the request the cache was there to save.

The accepted cost is that rotating a token on the same account discards a warm cache. That is rare,
and its price is one wasted fetch rather than wrong data. The hash is a derived value and not a
secret, but it does reveal on-disk that this machine holds *N* distinct Pipedrive credentials; that is
judged acceptable.

### 3. TTL differs by resource, and a cache miss on a key can override it

- Field schemas: 24 hours.
- `users`: 1 hour.

They are separated because they go stale for different reasons. A schema changes when an admin edits
the field configuration; the user list changes when a person joins or leaves, which is the more
frequent event and the cheaper one to re-fetch.

**Beyond TTL, an unrecognised key forces one refresh.** If a response carries a 40-character hex key
that the cached schema does not describe, the schema is fetched once more and the stale entry is
replaced. The same rule applies to an `owner_id` absent from the cached `users` entry. The trigger is
safe to detect: a Pipedrive custom field key is fixed-length hex and cannot be confused with a
standard field name.

This exists because the clock alone leaves a real hole. An admin adds a field at 10:00, the agent runs
at 10:05, and without this rule the field shows as a raw hash until the next day. The only escape
would be `--no-cache`, which the agent has no reason to reach for — it does not know the field exists.
The refresh costs at most one extra request per invocation, and only when the cache is demonstrably
behind. Without `--resolve-fields` no hash is resolved, so nothing triggers it.

### 4. A cache hit does not count against `--max-requests`

`--max-requests <n>` bounds HTTP requests that reach the network. A served cache entry consumes no
token from the shared daily budget and occupies no slot in the 2-second burst window, so it is not
counted, and the request counter on the ADR-0002 trailer reports the same number.

The flag exists to protect colleagues' integrations, not to predict cost. Counting cache hits would
make the guard stricter than the hazard requires and would abort runs over work that never happened.
The price is that the ceiling is not deterministic across machines with different cache states; that
is bounded to at most six metadata requests and never touches a pagination walk. The flag is named
`requests` for this reason.

### 5. A broken entry is skipped, not fatal, and says so on stdout

Unparseable JSON, a zod rejection, an I/O error, wrong permissions or a schema-version mismatch all
have the same outcome: the entry is ignored, the resource is fetched fresh, and a `warning` line is
emitted — on stdout in machine mode per ADR-0002, on stderr under `--pretty`.

Silent skipping was rejected. A permanently unwritable cache directory would then waste a request on
every single run, draining the shared budget with no signal anywhere. Reusing the existing `warning`
line means this needs no new concept: ADR-0004 already emits `warning` for a record that fails
validation.

### 6. On-disk mechanics

These follow from the decisions above and are recorded rather than argued.

- Location `$XDG_CACHE_HOME/pd/<token-hash>/`, defaulting to `~/.cache/pd/`. Separate from the
  credential path `$XDG_CONFIG_HOME/pd/` fixed by research 08. Never beside the binary, never in the
  working directory — ticket 21 may ship `pd` as a compiled binary on a read-only path.
- Writes go to a temporary file in the same directory followed by `rename`, so a half-written entry
  is never observable. No locking: two concurrent `pd` processes write identical content, the last
  write wins, and both readers see an intact file.
- Every entry carries a schema version. A version the running binary does not recognise is treated
  exactly like a missing entry, so an upgrade never reads a stale shape.
- Files are `0600`. Field schemas and the user list are company data, and the directory name is
  derived from a credential.
- No credential is ever written to disk by the cache. Only the hash, and only as a directory name.

### 7. `pd cache info` and `pd cache clear`

Both perform zero HTTP requests.

`info` reports the cache path, the entries present and their ages. It answers the first question
anyone asks when `--resolve-fields` produces a surprising label: when was this schema fetched.

`clear` deletes the `~/.cache/pd/` subtree. It takes no path argument, no pattern and no flag that
could widen its target; the target is a constant.

The read-only property is defined over the Pipedrive API — `pd` issues GET requests and cannot alter
the CRM. It is not a property of the local filesystem. A tool that creates files but refuses to remove
them offloads the cleanup onto the user and buys no safety in return.

### 8. `--no-cache` skips the read and still writes

The flag bypasses the cached value and fetches fresh; the fresh response then replaces the cached
entry.

The alternative — touching the disk not at all — makes the flag non-self-healing. The situation that
produces a `--no-cache` run is a suspicion of stale data; if the run leaves the stale entry in place,
the suspicion recurs on every subsequent run and the flag becomes permanent, which is the same as
having no cache. Writing means one run restores the normal path. The "do not touch this disk" case
(read-only filesystem, container) is already handled: the write fails, a `warning` is emitted per
section 5, and the run continues.

## Consequences

- The cache cannot make `pd` return stale CRM records, because it never holds any.
- Two accounts on one machine cannot contaminate each other, regardless of what the profiles are named.
- `--max-requests` means network requests. Any documentation, the manifest and `AGENTS.md` must say so.
- Lead, note and activity field schemas cost one request per invocation to resolve. If that proves
  painful in practice, reopening the closed list is a new decision, not a bug fix.
- `users` caching is inert until ticket 18 delivers a v1 client.
- Ticket 15 (custom field resolution) inherits: schemas are per-credential, at most 24 hours old, and
  self-correcting on an unknown hash.
