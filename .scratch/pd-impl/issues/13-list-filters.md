# 13 — List filters

**What to build:** An agent runs `pd organizations list --ids 7,9,11` and gets those three organisations — and the same command with two hundred and fifty ids issues exactly three requests, chunked invisibly. It runs `pd deals list --updated-since 2026-08-01T00:00:00Z --sort-by update_time` and reads a day's changes instead of a CRM's history. Two flags the API would silently reconcile behind its back are refused offline instead.

This is the second half of the two-command join that replaces related-entity expansion.

**Blocked by:** 07

**Status:** ready-for-agent

Normative: ADR-0017 (list filtering), ADR-0018 (related-entity expansion), ADR-0003 (`--ids` chunking).

## The flags

`--ids`, `--owner-id`, `--person-id`, `--org-id`, `--deal-id`, `--pipeline-id`, `--stage-id`, `--status`, `--done` / `--not-done`, `--updated-since`, `--updated-until`, `--sort-by`, `--sort-direction`, `--filter-id`.

`lead_id` is dropped — leads are out of scope.

Notes for the implementer:

- **`--ids` accepts any number of ids**, deduplicates them, and chunks into requests of at most 100 **in the caller's order**. The chunk boundary is unobservable. An API ceiling the caller cannot see must never break a join over a large walk.
- Fewer distinct ids returned than named produces **one** `unmatched_ids` warning, exit 0, `complete: true`. A join silently dropping a row must be distinguishable from a row with no fields.
- **`--filter-id` with `--ids` is a usage error, exit 2, offline** — the API silently ignores `ids` when `filter_id` is present, and that surprise must not reach the caller.
- Timestamp flags take **RFC3339 verbatim** and are validated offline. `pd` never parses or normalises the value it sends.
- **There is no related-entity expansion**, no `--expand`, no `--include`. The two-command join is the documented answer:

```
pd deals list --fields title,org_id        # → org_id 7, 9, 11 …
pd organizations list --ids 7,9,11         # → the whole organisation records
```

  The fact that decided it: `ids` is a parameter on the **same operation** as the unfiltered list, so the second command issues exactly the request an in-run expansion would have issued. Request cost against the shared budget is identical either way.
- `--filter-id` is marked `"enumerable": false` in the manifest (ticket 16), because `pd` has no command that lists filter ids.

- [ ] Every named filter flag applies on the commands where it is valid, and is a usage error where it is not
- [ ] `--ids` accepts any number of ids, deduplicates, and chunks at 100 in caller order
- [ ] 250 ids issue exactly three requests (replay test)
- [ ] Duplicate ids issue the same requests as the deduplicated set (replay test)
- [ ] Two omitted ids produce exactly one `unmatched_ids` warning, `complete: true`, exit 0 (replay test)
- [ ] `--filter-id` together with `--ids` is exit 2 offline with zero dispatches
- [ ] `--updated-since` and `--updated-until` take RFC3339 verbatim, are validated offline, and are sent unmodified
- [ ] `--sort-by update_time` combines with `--updated-since`
- [ ] No `--expand` or `--include` flag exists
