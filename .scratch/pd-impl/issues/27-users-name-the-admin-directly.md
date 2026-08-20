# 27 — `pd users` names the admin directly

**What to build:** a user record that answers "is this person an admin" without the reader
parsing a list. `pd users list` and `pd users get <id>` emit two new booleans beside the
existing `access` array:

- `is_global_admin` — the `admin` flag of the `access` entry whose `app` is `global`
- `is_deal_admin` — the `admin` flag of the `access` entry whose `app` is `sales`

The name says `deal` while the wire says `sales` deliberately: Pipedrive's own UI calls the
role "deal admin", and the record speaks the vocabulary the operator reads on screen.

**Blocked by:** None — can start immediately.

**Status:** done

Normative: [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) §3 (the record schema
`pd` owns) and §5 (a rejected user record is a name lost from `--resolve` as well as from stdout),
and [ADR-0029](../../../docs/adr/0029-the-record-interior-passes-through.md) §1 (validate what `pd`
acts on, pass through what `pd` only emits).

## Observed

Ticket 26 put `access` on the record, so the fact is now on stdout. It is still hard to read:

```
{"type":"record","record_type":"user","id":14182285,"name":"antti lahtinen",…,"access":[{"app":"sales","admin":true,"permission_set_id":"c08c8320-…"},{"app":"global","admin":true,"permission_set_id":"3c7fe210-…"},{"app":"account_settings","admin":true,"permission_set_id":"ab5c19f0-…"}]}
```

To answer "who is an admin", a caller must know that the app is named `sales` and not `deals`,
must handle an entry that is absent rather than `false`, and must do it per record. Live account
data shows the shapes involved: eight users, three app values in use (`global`, `sales`,
`account_settings`), and `account_settings` present **only** with `admin: true` — absence is how
this API says "not an admin".

## Decisions taken

These were settled in the grilling session and are not open:

- **Two fields, not one per app.** The enum also carries `campaigns`, `projects`,
  `account_settings`, `partnership` and `nova`. Naming all seven would hard-code the enum into
  `pd` and leave a future Pipedrive product invisible. Two fields answer the question asked.
- **Always present, always a boolean.** An entry missing from `access` yields `false`. A record
  with no `access` at all, or with an `access` that does not read as a list of
  `{ app, admin }`, yields `false` for both. There is no `null` and no omitted key.
- **`access` stays.** The booleans are additive, per ADR-0007 §7's rule that resolution never
  removes the raw value. `permission_set_id` and the per-app flags have no other home.
- **The derivation never rejects a record.** An unrecognised `app` value is data `pd` skips, not a
  gate failure. ADR-0007 §5 kept an `app` enum out of the schema for this reason; the same rule now
  binds the reading code.
- **No new request.** The fields ride the existing unpaginated fetch and its one-hour cache. Cache
  entries hold raw wire records and validation runs on the way out, so a warm entry starts emitting
  the booleans with no refresh.

## Acceptance

- [x] `pd users list` emits `is_global_admin` and `is_deal_admin` on every record
- [x] `pd users get <id>` emits the same two fields
- [x] A user who is an admin of `global` only gets `is_global_admin: true`, `is_deal_admin: false`
- [x] A user who is an admin of `sales` only gets the opposite pair
- [x] A user with an `access` list that names neither app gets `false` for both
- [x] A record with no `access`, or an `access` that is not a readable list, gets `false` for both
      and still passes the gate
- [x] An unrecognised `app` value does not reject the record and does not change either boolean
- [x] `access` is still emitted, unchanged, and the six older keys keep their positions
- [x] `--fields is_global_admin` and `--fields is_deal_admin` select them, and `pd manifest` lists
      both as selectable
- [x] No new request: verified by a cache-warm run reporting `requests: 0`
- [x] ADR-0007 §3 is amended to name both fields in the kept list
- [x] ADR-0029 §1's boundary is amended: `pd` now reads inside `access`. The read path validates
      leniently (`app` as a string, `admin` as a boolean, no enum); `access` itself is still emitted
      without validation
- [x] The test named "the record carries only the fields ADR-0007 §3 keeps" is updated rather than
      left stating something false
- [x] `AGENTS.md` documents both fields, including that absence of an entry reads as `false`

## Comments

The example the requester brought in reads `access.find(item => item.app === 'global').admin`,
which throws when no `global` entry exists. That crash is the whole reason the absence rule above is
written down: on this account four of eight users have no `account_settings` entry at all, so a
missing entry is the common case, not the edge case.
