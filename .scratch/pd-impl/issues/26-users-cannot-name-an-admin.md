# 26 — `pd users` cannot say who administers the account

**What to build:** a `pd users list` whose output answers "which of these people is an admin".

**Blocked by:** None — can start immediately.

**Status:** done

Normative: [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) §3 (the record schema
`pd` owns) and [ADR-0029](../../../docs/adr/0029-the-record-interior-passes-through.md) §1 (validate
what `pd` acts on, pass through what `pd` only emits).

## Observed

Asked which users are admins, `pd` cannot answer:

```
$ pd users list --limit 200
{"type":"record","record_type":"user","id":14182285,"name":"antti lahtinen","email":"…","active_flag":true,"is_deleted":false,"timezone_name":"Europe/Helsinki"}
```

Six fields, none of them about permissions. Pipedrive **does** send the answer. The v1 `GET /users`
response carries it, and the generated schema describes it exactly:

```ts
access: z.array(z.object({
  app: z.enum(['global','sales','campaigns','projects','account_settings','partnership','nova']),
  admin: z.boolean(),
  permission_set_id: z.string(),
}))
```

It never reaches stdout. `UserRecord` is a `z.object`, `users` is the one resource ADR-0029 §6 left
closed, and zod strips what a shape does not declare. The fact arrives at the process boundary and
is discarded one line later.

## Why it is worth fixing

"Who is an admin" is an ordinary question about a CRM's users, and the credential guidance in
`AGENTS.md` makes it a security-adjacent one: an operator choosing a restricted token wants to know
who is privileged. The answer costs no request — `users` is one unpaginated fetch, cached for an
hour, and `access` is already in the response body being parsed.

## What to change

One field on `UserRecord`, declared as `z.unknown()`:

```ts
access: z.unknown().optional(),
```

Three decisions taken rather than left open:

- **`z.unknown()`, not the wire shape.** `pd` never reads inside `access`; ADR-0029 §1 says a value
  `pd` only copies is not validated. The declaration exists to stop the strip, not to gate.
- **No `app` enum, emphatically.** `UserRecord` is the gate as well as the vocabulary, so a rejected
  record vanishes from `--resolve` as well as from stdout. An enum would turn a Pipedrive product
  launch into unnameable deal owners — the exact failure ADR-0007 §5 exists to prevent.
- **Appended after `timezone_name`.** Shape order is output key order on this resource, so appending
  leaves the existing six keys where they are.

`--fields access`, the manifest's `selectable_fields` and the `--fields` vocabulary all derive from
`Object.keys(vocabulary.shape)` and need no edit. Neither does the cache: entries hold raw wire
records and validation runs on the way out, so a warm entry starts emitting `access` immediately.

## Acceptance

- [x] `pd users list` emits `access` when Pipedrive sends it, unchanged
- [x] `--fields access` selects it, and `pd manifest` lists it as selectable
- [x] A user record with no `access` still passes the gate
- [x] An unrecognised `app` value does not reject the record
- [x] The other six keys keep their positions
- [x] No new request: the field rides the existing unpaginated fetch and its one-hour cache
- [x] ADR-0007 §3 is amended to name `access` in the kept list

## Comments

Asked live for the admins of the account, `pd` had to answer "the field does not exist here" while
the generated v1 schema three directories away described it in full. That is the whole ticket.

The test that pinned the closed key list is named "the record carries only the fields ADR-0007 §3
keeps", so the ADR amendment is not optional bookkeeping — without it the test name is false.
