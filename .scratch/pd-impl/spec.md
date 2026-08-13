# Spec pointer: building `pd`

The normative spec for this effort is [`../pd-cli-design/spec.md`](../pd-cli-design/spec.md), assembled
from ADR-0001 … ADR-0021 under [`docs/adr/`](../../docs/adr/). Where this effort's tickets and an ADR
disagree, the ADR wins — and [ADR-0021](../../docs/adr/0021-distribution-build-from-source.md)
supersedes ADR-0014 whole, so the distribution and CI parts of tickets 01, 03, 05, 19 and 20 were
rewritten against it on 2026-08-13 — except in the three places the spec rules, which are restated inline in the
tickets that touch them:

1. `resolved` is `"off"` / `"partial"` / `"full"`, never `none` (tickets 05, 11, 16).
2. A `--max-requests` stop is an `error` trailer with `code: "request_ceiling"`, exit 3. There is no
   `reason: "max_requests"` (ticket 06).
3. An unrecognised command is `code: "usage"`, exit 2. `unknown_command` is not a `code` (tickets 07, 16).

The design effort's own map is [`../pd-cli-design/map.md`](../pd-cli-design/map.md). Design ticket 22
there stays open until tickets 19 and 20 here are done.

## Dependency order

```
01 ──┬── 02 ── 04 ──┐
     └── 03 ────────┴── 05 ──┬── 06 ──┬── 10 ── 11 ── 12 ──┐
                             │        └── 17 ── 18 ────────┤
                             ├── 07 ──┬── 13 ── 14 ── 15 ──┤
                             │        └── 16 ── 19 ────────┤
                             └── 08 ── 09 ─────────────────┴── 20
```

`10` is blocked by both `06` and `07`; `14` by both `10` and `13`; `20` by `09`, `11`, `12`, `15`,
`18` and `19`.
