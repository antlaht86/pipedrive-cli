# 29 — `access` is selected, not sent

**What to build:** `pd users list` and `pd users get <id>` stop emitting `access` by default.
`--fields access` still emits it, unchanged. The field stays in the record schema, stays in
`pd manifest`'s selectable list, and stays the thing the two admin booleans are derived from.

**Blocked by:** None — 27 and 28 are shipped.

**Status:** done

Normative: [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) §3 (the record schema
`pd` owns) and §7 (resolution adds, it never removes), and
[ADR-0016](../../../docs/adr/0016-field-projection.md) §5 (projection removes fields, never
records) and §8 (the manifest lists selectable fields per command).

## Observed

Ticket 26 put `access` on the record and ticket 27 derived `is_global_admin` and `is_deal_admin`
from it. The booleans answer the question; the array is what they were read out of, and it is by
far the widest thing on a user line:

```
{"type":"record","record_type":"user","id":14182285,"name":"antti lahtinen",…,"access":[{"app":"sales","admin":true,"permission_set_id":"c08c8320-…"},{"app":"global","admin":true,"permission_set_id":"3c7fe210-…"},{"app":"account_settings","admin":true,"permission_set_id":"ab5c19f0-…"}],"is_global_admin":true,"is_deal_admin":true}
```

Three UUIDs and three objects, on every record of every run, to carry a fact two booleans beside
them already state. An agent reading `pd users list` pays for it in context on every user and
almost never reads it.

## Decisions taken

- **Withheld, not removed.** `access` keeps its place in `UserRecord`, so `--fields access` works
  with no new selector syntax, `pd manifest` keeps listing it, and the derivation keeps reading it.
  What changes is one thing: the default output, when no `--fields` is given.
- **The strip lives in the projection, not in the schema.** ADR-0016 §5 already makes projection the
  one stage that removes fields, and putting it there means the key order, the identity field and
  the `--pretty` path all keep behaving as they do. A schema change would have taken `access` out of
  `--fields` too, which is the opposite of what this asks for.
- **A resource declares what it withholds.** The source carries the list, so the mechanism is
  general and the policy is local. `users` is the only resource that declares one.
- **`includes` stays a deny-list.** ADR-0008's resolver asks the projection whether a field survived
  and treats an absent projection as "everything survived". A default projection that answered
  allow-list would silently switch resolution off — so it answers "everything except what is
  withheld", and a `--resolve` run with no `--fields` resolves exactly as it did before.
- **The other nine resources are untouched.** A source with nothing withheld produces no projection
  at all, which is the passthrough path they take today.
- **No manifest key.** `selectable_fields` already lists `access` and that is what `--fields`
  accepts. `AGENTS.md`, which `pd docs` embeds, is where "select it explicitly" is written.

## Acceptance

- [x] `pd users list` emits no `access` key
- [x] `pd users get <id>` emits no `access` key
- [x] `pd users list --fields access` emits `access`, byte-for-byte the array Pipedrive sent
- [x] `pd users get <id> --fields access` does the same
- [x] `is_global_admin` and `is_deal_admin` are still emitted by default and still correct, so the
      derivation reads `access` before the projection withholds it
- [x] `--admin global` and `--admin deal` still filter correctly with `access` absent from output
- [x] `--fields access,is_deal_admin` emits both, and `id` as always
- [x] `pd manifest` still lists `access` under `pd users list` and `pd users get`
- [x] `pd users list --resolve` resolves exactly as it did before, with no `--fields` given
- [x] `pipelines`, `stages`, `fields` and the five live resources emit every field they did before
- [x] The test named "the record carries only the fields ADR-0007 §3 keeps" is updated rather than
      left stating something false
- [x] ADR-0007 is amended: `access` is selectable and not default-emitted, and §7's rule is about
      `--resolve` rather than about the default projection
- [x] `AGENTS.md` documents that `access` needs `--fields access`

## Comments

The hazard here is the resolver's `projection?.includes(field) ?? true`. Today a run with no
`--fields` has no projection and the `?? true` fires; after this ticket `users` has one, and if its
`includes` were written as an allow-list every `--resolve` run would quietly stop resolving. That is
the same shape of failure ticket 28 removed from the filter path: an answer that looks right and is
wrong.
