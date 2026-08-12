# Draft command surface for `pd`

Asset for [ticket 19](../../issues/19-prototype-command-surface.md). This is the **draft that was
reacted to**, kept as written so the rejected options stay visible. Every **FORK** below is now
closed by [ADR-0009](../../../../docs/adr/0009-command-surface-and-manifest.md):

| Fork | Outcome |
| --- | --- |
| A — first surface size | Minimal + fields: nine resources, no projects, no deal children, no followers, no archived |
| B — short flags and aliases | Absent, as drawn |
| C — Pipedrive vocabulary | Pipedrive wins: `persons`, `organizations`, no aliases |
| D — read-only legibility | All three of help line, manifest field, teaching refusal |
| E — manifest emission | `pd manifest` subcommand |
| F — manifest contents | As listed, plus the `resolved` vocabulary; no per-command request cost |
| F1 — manifest version | Integer, incremented only by a breaking change; the fog patch closes |
| shape (section 2) | A — noun then verb |

The locked surface lives in `manifest.sample.json` and `help-samples.txt`, both updated to match.
One thing the draft missed and the ADR fixes: [ADR-0005](../../../../docs/adr/0005-cache-design.md) §7
had already created `pd cache info` and `pd cache clear`, which break both the grammar and the
"the only verbs are list and get" refusal message drafted in section 5.

Source of the resource list: `paths` of the v2 OpenAPI spec (30 top-level paths, enumerated
mechanically), plus the single v1 operation `GET /users` that ADR-0007 admits.

---

## 1. What is readable in the account at all

v2 GET-able resources, grouped by what they mean to a caller:

| Group | v2 paths | Notes |
| --- | --- | --- |
| Core records | `/deals`, `/deals/{id}`, `/deals/archived`, `/persons`, `/persons/{id}`, `/organizations`, `/organizations/{id}`, `/activities`, `/activities/{id}`, `/products`, `/products/{id}` | the bread and butter |
| Deal children | `/deals/{id}/products`, `/deals/{id}/discounts`, `/deals/{id}/installments`, `/deals/products`, `/deals/installments` | cross-deal variants exist too |
| Pipeline metadata | `/pipelines`, `/pipelines/{id}`, `/stages`, `/stages/{id}` | small, near-static |
| Field schemas | `/dealFields`, `/personFields`, `/organizationFields`, `/productFields`, `/activityFields`, `/projectFields`, and each `/{field_code}` + `/options` | ADR-0005 caches five of these |
| Projects (v2, re-released 2026) | `/projects`, `/projects/{id}`, `/projects/archived`, `/projectTemplates`, `/tasks`, `/boards`, `/phases`, `/projects/{id}/changelog` | a whole second product area |
| Followers | `/deals/{id}/followers`, and person/org/product siblings, plus `.../followers/changelog` | thin, per-record |
| Search | `/deals/search`, `/persons/search`, `/organizations/search`, `/products/search`, `/leads/search`, `/itemSearch`, `/itemSearch/field` | stricter rate limit (research 01) |
| v1 survivor | `GET /users` | ADR-0007; the only v1 call |

Deliberately unreachable: everything ruled out by the map's Out of scope — all writes, all v1 except
`users`, and the seven excluded `users` endpoints.

**FORK A — first surface size.** Three candidate cuts:

- **Minimal**: deals, persons, organizations, activities, products, pipelines, stages, users. Eight
  resources. Everything else waits for demand.
- **Minimal + fields**: the above plus a `fields` command exposing the cached schemas
  (ADR-0008 names a hypothetical `pd fields list` and leaves its existence to this ticket).
- **Everything readable**: the above plus projects/tasks/boards/phases, deal children, followers,
  archived variants. Admits `/projectFields` to ADR-0005's cache rule automatically.

---

## 2. Three shapes for the same six invocations

Same work, three grammars. Read each column as a model that has never seen `pd` before.

| Intent | **A — noun then verb** | **B — verb then noun** | **C — flat** |
| --- | --- | --- | --- |
| all deals | `pd deals list` | `pd list deals` | `pd deals` |
| one deal | `pd deals get 123` | `pd get deal 123` | `pd deal 123` |
| all persons | `pd persons list` | `pd list persons` | `pd persons` |
| one person | `pd persons get 901` | `pd get person 901` | `pd person 901` |
| all users | `pd users list` | `pd list users` | `pd users` |
| one user | `pd users get 42` | `pd get user 42` | `pd user 42` |

What each buys:

- **A** groups by resource, so `pd deals --help` is a natural page and the manifest nests one flag
  table per resource. Costs a plural/singular mismatch: `pd deals get 123` returns one deal from a
  plural noun.
- **B** groups by verb, so the read-only property is visible in the verb list itself: two verbs,
  `list` and `get`, and no third. Costs a flat namespace — `pd get --help` must list every resource.
- **C** is the shortest and has the fewest tokens to get wrong, but the meaning of the argument is
  positional and untyped: `pd deals 123` is a plausible typo that means nothing, and there is no
  place to hang a resource-scoped help page.

ADR-0007 already wrote `pd users list` and `pd users get <id>` in prose, which is shape A — but it
wrote them as illustration, not as a decision.

---

## 3. Global flags

Every flag below applies to every command. Locked and already-decided ones first:

| Flag | Unit / values | Default | Source |
| --- | --- | --- | --- |
| `--pretty` | boolean | off | locked note 4; unstable human table (ADR-0002) |
| `--no-cache` | boolean | off | locked note 4 |
| `--max-requests <n>` | network requests | unset | locked note 4; cache hits do not count (ADR-0005) |
| `--limit <n>` | records | unset | ADR-0003; the only bound |
| `--resolve` | boolean | off | ADR-0007/0008; hashes, option labels, owner ids, relations |
| `--resolve-budget <n>` | network requests | 50 | ADR-0008 |
| `--help` | boolean | — | locked note 4, on every subcommand |

Pending other open tickets — the surface must leave room, and this ADR must not decide them:

| Flag | Owner |
| --- | --- |
| `--fields <sel>` projection | ticket 25 |
| concurrency knob, if any | ticket 17 |
| budget floor / override, if any | ticket 16 |
| credential selection (`--token-file`, `--profile`) | ticket 20 |

**FORK B — short flags and aliases.** Drawn here as **absent**: no `-p`, no `-l`, one spelling per
concept. The locked policy says the agent wins, and an agent choosing between `-p` and `--pretty`
is a coin flip that costs manifest surface. Stated as an assumption, not a question.

---

## 4. Naming: Pipedrive's vocabulary versus command-friendly names

| Pipedrive calls it | Candidate command noun | Clash |
| --- | --- | --- |
| Organization | `organizations` | 14 characters, and Pipedrive's own UI says "Org" everywhere. Alias `orgs`? |
| Person | `persons` | English wants `people`; Pipedrive's API says `persons` and so does every field name (`person_id`) |
| Deal | `deals` | none |
| Activity | `activities` | none |
| User | `users` | none — but a `user` here is a Pipedrive seat, not the CLI's caller |
| Field schema | `fields` | Pipedrive says `dealFields`; a flat `pd fields list --entity deal` re-spells it |

**FORK C.** Where they disagree, does the API's spelling win (an agent that has seen Pipedrive's docs
transfers knowledge, and `person_id` in the output then matches the command) or does English
(`people`, `orgs`)?

---

## 5. Making read-only legible

Four candidates, not mutually exclusive:

1. **Verb inventory.** Shape B makes it structural: the only verbs are `list` and `get`.
2. **A line in `--help`.** `pd` is read-only. It issues GET requests only and cannot create, update
   or delete anything. — one sentence, on the root help and in every subcommand footer.
3. **A manifest field.** `"read_only": true` at the manifest root, so a harness discovers it without
   reading prose.
4. **A refusal that teaches.** `pd deals create` exits 2 with
   `code: "unknown_command"` and a message saying no write command exists in this tool at all.

**FORK D.** Which of these ship. 4 costs a hardcoded list of verbs `pd` will never have.

---

## 6. Manifest emission

**FORK E.** Three mechanisms:

- **`pd manifest`** — a subcommand. Discoverable from `pd --help`, costs one command name in the
  namespace, and is the only form that can report the running binary's version truthfully.
- **`pd --manifest`** — a global flag. Same content, no namespace cost, but reads oddly next to
  `pd deals list --manifest`, which must then be an error.
- **A committed `manifest.json`** shipped in the package. A harness can read it with no process
  spawn, but it can drift from the installed binary if the file is not generated at build time.

Generation is not a fork: the manifest and every `--help` text are generated from **one** in-code
command table, so they cannot drift. That is an implementation decision, recorded as an assumption.

**FORK F — what the manifest must express.** Beyond names and flags, the pieces prior ADRs put
there:

- the output format, declared **once globally** as NDJSON (ADR-0002)
- per command, whether it **streams or collects** (ADR-0004), because a collected command's
  time-to-first-byte is its total wall time
- the exit codes 0/1/2/3 and the `code` vocabulary (ADR-0001)
- that trailers carry `complete`, `emitted`, `skipped`, `duplicates`, `resolved`
- **not** a per-command request cost: `pd users get 42` is answered from cache and legitimately
  reports `requests: 0`
- **FORK F1** — a manifest version, and how a harness detects a manifest it does not understand.
  The map's fog lists "Manifest schema and its versioning" as its own patch; this may stay open.
