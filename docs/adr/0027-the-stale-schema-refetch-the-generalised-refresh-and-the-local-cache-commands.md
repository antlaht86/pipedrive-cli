# ADR-0027: The stale-schema refetch, the generalised refresh, and the two local cache commands

Status: accepted
Date: 2026-08-13
Deciding ticket: [Cache and the four cached resources](../../.scratch/pd-impl/issues/08-cache-and-the-four-cached-resources.md)
Extends: [ADR-0005](0005-cache-design.md) §3, §6, §7 — the version stamp, the unrecognised-key refresh and the two cache commands
Extends: [ADR-0007](0007-the-narrow-v1-users-client.md) §4 — the by-id refresh, written for `users` and generalised here
Extends: [ADR-0010](0010-budget-guard.md) §7 — the sentinel `pd cache clear` must spare, named here because `clear` ships first

## Context

Ticket 08 built the cache. Five questions it had to answer are not in
[ADR-0005](0005-cache-design.md), and each of them would otherwise be answered
differently by accident in tickets 09, 11 and 16.

Two of them come from the same place: ADR-0005 §6 gives every entry a schema
version and says an unrecognised one reads as missing. That version stamps the
**file format**. It cannot see the other thing that goes stale — the generated
zod record schemas, which change whenever `bun run openapi-ts` is run against a
moved spec. An entry written before a regeneration is version-current and
schema-obsolete, and nothing in ADR-0005 notices.

The rest are scope questions: how far ADR-0007 §4's by-id refresh reaches, what
`pd cache info` and `pd cache clear` need before they can run, and where
`--no-cache` exists while `--resolve` does not yet.

## Decision

### 1. An entry no record of which survives validation is refetched, not reported

`pd` validates cached data on **read**, against the same record schema a fresh
response meets — that is what makes `--no-cache` a statement about request count
rather than about what `pd` accepts. The failure mode that follows is the one
above: every record in a warm entry fails a schema that has moved on.

Reporting that would be wrong twice. It would fail a run that the same command
against a cold cache completes, and it would report `invalid_response` — *the
schema does not describe this resource* — about a resource Pipedrive is
describing perfectly well. So zero survivors out of a non-empty **cached** list
is read as evidence about the disk, not about Pipedrive: the entry is refetched
once, the fresh answer replaces it, and the run continues.

A cold fetch keeps [ADR-0006](0006-validation-placement-and-rejection.md) §4's
rule unchanged. Zero survivors from the network still ends the run as
`invalid_response`, because there is nothing left to blame but the schema.

The same reasoning binds `get`, where the observable is one record rather than a
whole list: a matched record that fails the schema on a warm entry is refetched
once before the run reports `invalid_response`. Without that, `pd stages get 3`
would fail warm and succeed cold, which is precisely the asymmetry this section
exists to remove.

The accepted cost is one extra request in a rare case, and it is bounded: the
refetch happens once per run and cannot recur, because a fresh list is never
refetched.

### 2. The absent-id refresh applies to all four cached resources

ADR-0007 §4 gave `pd users get <id>` a one-shot refresh: an id absent from the
cached list forces one re-fetch regardless of TTL, and only then is the run
`not_found`. It was written for `users` because `users` was the only cached
resource with a `get` at the time.

[ADR-0009](0009-command-surface-and-manifest.md) §3 then gave all four cached
resources a `get` that filters the cached list, and the argument transfers
whole. A stage created this morning is as invisible to a 24-hour `stages` entry
as a colleague who joined this morning is to a 1-hour `users` entry, and
`not_found` for something that exists is the worst answer `pd` can give: it is
indistinguishable from the truth.

So the refresh is a property of *filtering a cached list*, not of `users`. The
cost is one request on a genuine miss — the case that was about to end the run
anyway — and zero on every hit.

### 3. `pd cache info` and `pd cache clear` resolve no credential

ADR-0005 §7 calls `clear`'s target a constant: the `pd` cache subtree. Both
commands therefore take the **root** of that subtree and never the credential's
directory within it, which means neither resolves a token.

This is not a convenience. The human running either command is very often the
human whose credential is exactly what is broken, and a `clear` that first
demanded a working token would be unavailable precisely when it is wanted. The
consequence is that `info` reports across every credential's directory, labelled
by the fingerprint [ADR-0012](0012-authentication-and-credential-resolution.md)
§5 already prints — which is more useful than the single-credential view a token
would have bought, not less.

Both remain zero-request commands, both emit one JSON object rather than NDJSON
(ADR-0009 §8), and both refuse every argument and flag, including
`--token-file`.

**The sentinel's filename is reserved here**: `blocked.json`, inside the
credential's directory. ADR-0010 §7 requires `clear` to spare it, and `clear`
ships one ticket before the sentinel does — so the name is fixed in
`src/lib/cache/entries.ts` now, and ticket 09 writes the file that name refers
to rather than choosing a name `clear` has already been taught to delete.

### 4. `--no-cache` exists on the cached resources only, for now

The flag is global in [ADR-0009](0009-command-surface-and-manifest.md) §"Six
flags are already global", but the five live resources read no cache and will
not until `--resolve` gives them one to read. Accepting it there today would
document a flag that does nothing, which costs an agent a turn to discover.

It is therefore on `users`, `pipelines`, `stages` and `fields`, and ticket 11
adds it to the live resources in the same change that gives it an effect. This
is an append to a per-command flag list, which ADR-0026 §1 already made the
shape of that table.

### 5. `record_type` is `field` for all five entities

`pd fields list --entity deal` emits `{"record_type":"field", …}`, not
`deal_field`. ADR-0009's assumption section makes `record_type` the singular of
the resource noun and calls it "the only singular/plural mapping on the surface;
an agent inverting it has exactly one rule to learn". A per-entity
`record_type` would break that rule for one resource, and it would encode in
every line an answer the caller supplied in the command it just typed.

## Consequences

- **A warm cache can cost one request.** ADR-0005 §4's `requests: 0` is the
  property of a warm entry `pd` can *use*; §1 and §2 above each name a case
  where a warm entry earns a refetch instead. Neither is reachable without
  either a schema regeneration or a genuine miss, and documentation must not
  promise zero requests per warm run as an invariant.
- **Ticket 09 inherits a filename.** `SENTINEL_FILE` in
  `src/lib/cache/entries.ts` is the name `pd cache clear` already spares and
  `pd cache info` already reports; the ticket owns the file's contents, its
  15-minute expiry and the refusal it produces.
- **Ticket 11 inherits two.** `--no-cache` becomes global when `--resolve`
  lands, and the `users` fetch that is fatal here degrades there — the asymmetry
  ADR-0007 §8 already recorded.
- **`pd cache info` reports more than the ticket asked for**: per entry a
  `credential`, a `ttl_seconds`, a `stale` flag, or `readable: false` for an
  entry `pd` would skip. `clear` reports `removed` and `preserved`. All of it is
  additive and none of it is a line type, so ADR-0002's grammar is untouched.
- Nothing here changes an output line shape or a `code`, so `manifest_version`
  does not move.
