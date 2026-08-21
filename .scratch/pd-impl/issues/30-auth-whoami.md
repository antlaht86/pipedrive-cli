# 30 — `pd auth whoami` asks who the credential is

**What to build:** a command that answers, in one live request, both "does this API key still
work" and "whose key is it". Today neither question has an answer: `pd auth status` prints a
fingerprint and no name, and `pd users list` returns the whole collection with nothing marking
which row is the caller.

```
$ pd auth whoami
{"type":"record","record_type":"whoami","id":14182285,"name":"antti lahtinen","email":"…","active_flag":true,"timezone_name":"Europe/Helsinki","company_id":1234567,"company_name":"…","company_domain":"…","tier":"config-file","fingerprint":"a1b2c3d4e5f60718"}
{"type":"summary","complete":true,"emitted":1,"requests":1}
```

**Blocked by:** None — can start immediately.

**Status:** done

Normative: [ADR-0033](../../../docs/adr/0033-the-live-identity-probe.md) in full. It amends
[ADR-0012](../../../docs/adr/0012-authentication-and-credential-resolution.md) §6 (which rejected a
live `GET /users/me` on validity grounds alone) and
[ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) §1 (the v1 generation filter).

## Decisions taken

Settled in the grilling session. Not open:

- **A new command, not a wider `pd auth status`.** ADR-0012 §5's "zero network requests" survives
  untouched: `status` still describes a configuration without using it, still works offline, still
  exits 0 or 2 and never 1. A `--live` flag on `status` was rejected — one command with two output
  shapes and two exit surfaces selected by a flag is the hardest contract for an agent to read.
- **A data command, so the error model is inherited whole.** `whoami` uses the credential, which
  hands it ADR-0012 §7 unamended. A dead or missing credential is `auth`, exit 1. No network is
  `upstream`, exit 1. A spent burst window or daily budget is `rate_limited` / `budget_exhausted`,
  exit 3. No new exit-code rule is written for this command.
- **No `works` field.** Success is the proof. The field would be constant, because the branch that
  would set it `false` has no record to hang it on, and a caller learns strictly more by reading
  `code` — which ADR-0001 already requires it to read.
- **The record is a `users` record plus a company block plus the local join.** `id`, `name`,
  `email`, `active_flag` and `timezone_name` shaped exactly as `pd users` shapes them, so an
  agent can compare `whoami`'s `id` against any deal's `owner_id` with no conversion. Plus
  `company_id`, `company_name`, `company_domain`. Plus `tier` and `fingerprint` — the pair no
  single existing source can produce, and the one thing that says which cache directory belongs to
  whom when two tokens live on one machine.
- **`is_global_admin` / `is_deal_admin` are conditional.** They derive from `access`, and the
  `/users/me` response schema does not declare it. Where `access` is absent both fields are
  **omitted**, never emitted as `false` — `false` would state that the caller is not an admin,
  which is not what was learned. This is the one place `whoami` differs from ticket 27's rule for
  `pd users`, and it is deliberate: there the absence of an entry inside a present `access` means
  "not an admin"; here the whole array is missing, which means "not asked".
- **NDJSON with a trailer, not one JSON object.** ADR-0009 §7's exception for `pd manifest` and
  `pd auth status` rests on three grounds and `whoami` fails the third: it dispatches a request, so
  the trailer has a `requests` count to report and an `error` trailer is reachable. `pd users get
  <id>` is the exact precedent — one record, NDJSON, trailer.
- **`--pretty` and `--fields` work, with no new rules.**
- **Never cached.** Not a read, not a write, and `--no-cache` changes nothing. A cached "your token
  works" is a claim about a request that was not made. The closed list of eight cache entries in
  ADR-0005 is unchanged; `whoami` sits outside it.
- **The v1 filter grows to two anchored operations.** `getCurrentUser` re-enters;
  `getUser`, `findUsersByName`, `getUserFollowers`, `getUserPermissions`, `getUserRoleAssignments`
  and `getUserRoleSettings` stay out. The hand-written-wrapper branch stays closed — ADR-0007 §1's
  locked point 2 admits no exception.

## Known friction

`UserRecord` declares `is_global_admin` and `is_deal_admin` as **required** booleans, because ticket
27 could guarantee them from the `/users` response. ADR-0033 §4 makes them conditional here, so
`whoami` cannot reuse `UserRecord` verbatim. Resolve it one of two ways and say which in the commit:
a separate record schema for `whoami`, or loosening those two members in the shared schema. Do not
paper over it by defaulting them to `false` — that is the reading ADR-0033 §4 explicitly rejects.

The `/users/me` response schema is known from research 05 §5 (`x-token-cost: 2`, fields `id`,
`name`, `email`, `active_flag`, `timezone_name`, `role_id`, `permission_set_id`, `company_id`,
`company_name`, `company_domain`). Whether `access` in fact arrives is settled by the first real
response, not by this ticket.

## Acceptance

- [x] `pd auth whoami` emits one NDJSON record and one trailer, and exits 0, with a working token
- [x] The record carries `id`, `name`, `email`, `active_flag`, `timezone_name`, `company_id`,
      `company_name`, `company_domain`, `tier` and `fingerprint`
- [x] `tier` and `fingerprint` match what `pd auth status` reports for the same configuration
- [x] A rejected token exits 1 with `code: "auth"`, and no record reaches stdout
- [x] No credential anywhere in the chain exits 1 with `code: "auth"` — not exit 0, and not the
      `found: false` shape `pd auth status` uses
- [x] A transport failure exits 1 with `code: "upstream"`; a 429 exits 3
- [x] No `works` field exists on the record, in the manifest, or in `AGENTS.md`
- [x] `is_global_admin` and `is_deal_admin` appear only when `access` is present in the response,
      and are omitted otherwise
- [x] `pd auth status` is unchanged: still zero network requests, still exits 0 with no credential,
      and its output has no new field
- [x] `--pretty` renders the record through the shared aligned renderer
- [x] `--fields company_domain` selects a single key, and `pd manifest` lists the command with its
      selectable fields and its exit codes
- [x] The trailer reports `requests: 1` on every run, warm or cold — no cache path exists
- [x] The v1 generation filter names exactly two anchored operations, and the generated surface
      exports exactly `getUsers` and `getCurrentUser`
- [x] The read-only guard sees the request like any other `GET`; no new exemption is added
- [x] `AGENTS.md` documents the command, its record, and the `code` values a caller branches on
