# 10 — `--fields` projection

**What to build:** An agent runs `pd deals list --fields title,value,org_id` and pays for three fields instead of forty on every record of a forty-thousand-record walk. A typo in a field name is refused **offline** with exit 2 and a list of valid names — it never produces plausible output with a field quietly missing. `id` arrives whether or not it was selected, so every record stays followable.

**Blocked by:** 06, 07

**Status:** ready-for-agent

Normative: ADR-0016 (field projection), ADR-0020 (absence).

Notes for the implementer:

- `--fields <name>[,<name>…]`, repeatable and accumulating, duplicates deduplicated. **No negation, no wildcards, no `--exclude`.**
- **`id` is always emitted**, along with `type` and `record_type`.
- Selector grammar: a bare top-level name, or `custom_fields.<hash>`. **No deeper dotting.** `prices` on a product is selectable whole and no path reaches inside it.
- **A display name is never a legal selector.** `pd fields list --entity deal` is how a human learns a hash.
- **A resolution artifact rides with its raw field and is never selectable alone.** `custom_fields_resolved`, `org_name` and its six siblings are not legal selectors; naming one is a usage error whose message names the raw field instead. This buys the invariant that **the legal selector set does not depend on `--resolve`.**
- **Projection removes fields, never records.** A record whose every selected field is absent still emits as `{"type":"record","record_type":"deal","id":42}`.
- An unknown top-level name is exit 2 **offline**, listing the valid names. A syntactically valid hash matching zero records across the whole run is one `unmatched_field_selector` **warning**, not an error — projecting over a walk of open deals must not become forty thousand warnings.
- `--fields` on an empty field yields a **shorter line**, not a warning.
- **Key order in machine mode is `pd`'s schema order**, not selector order, so two callers selecting the same fields get byte-identical records. Under `--pretty` it is selector order (ticket 18).
- **Push-down**: send the upstream `custom_fields` query parameter (max 15 keys; available on deals, persons, organizations and products) when **every** condition holds — the endpoint offers it, every custom-field selector is a hash, bare `custom_fields` was not selected, and the count is ≤ 15. Otherwise fetch whole records and trim locally.
- **Output is byte-identical either way.** Push-down is an optimisation and never a contract difference. The test asserting this is the **highest-value single test in the design** — it is the only thing standing between an upstream optimisation and a silent contract change. It needs a fixture **pair** recorded from the same account state, which is a recording-time constraint.
- **`include_fields` is never sent.** It is additive, not subtractive, and its namespaces are outside `pd`'s record schema.
- Projection happens **after** zod validation and **before** the resolve prefetch, so it shrinks `--resolve-budget` consumption as a side effect (ticket 12).
- The single-JSON-object commands (`manifest`, `auth status`, `cache info`, `docs`) **reject** `--fields` as a usage error rather than ignoring it.
- **Known probe:** whether `custom_fields=` with an empty value means "none" upstream. If it does, dropping every custom field from a large walk is the single largest response-size win available. `pd` does not gamble on it — omit the parameter — but the probe is one keystroke and worth running.

- [ ] `--fields` projects, is repeatable, accumulates, and deduplicates selectors
- [ ] `id`, `type` and `record_type` survive projection unconditionally
- [ ] `custom_fields.<hash>` is a legal selector and no deeper dotting is
- [ ] An unknown top-level selector exits 2 **offline** with zero dispatches and lists the valid names
- [ ] Naming a resolution artifact is a usage error whose message names the raw field
- [ ] The legal selector set is identical with and without `--resolve`
- [ ] A record whose every selected field is absent still emits with `id`
- [ ] A valid hash matching zero records produces one `unmatched_field_selector` warning
- [ ] Key order in machine mode follows `pd`'s schema order regardless of selector order
- [ ] Push-down fires only under all four conditions, and the same projection with and without it is **byte-identical** (replay test, fixture pair)
- [ ] `include_fields` is never sent
- [ ] `--fields` on a single-JSON-object command is a usage error
