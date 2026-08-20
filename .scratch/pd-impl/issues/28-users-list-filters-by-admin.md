# 28 — `pd users list --admin <global|deal>`

**What to build:** a way to ask for the admins alone. `pd users list --admin global` emits only the
users whose `is_global_admin` is `true`; `pd users list --admin deal` emits only the deal admins.
Any other value is a usage refusal that names the two it accepts. The flag exists on `list` only.

**Blocked by:** 27 — the filter selects on the booleans that ticket derives.

**Status:** done

Normative: [ADR-0001](../../../docs/adr/0001-error-model-and-exit-codes.md) (the `usage`
refusal), [ADR-0003](../../../docs/adr/0003-pagination-bounding-and-partiality.md) (`--limit` and the summary trailer)
and [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) §4 (`get` is served from the
cached list).

## Observed

`stages` already carries the only command-scoped list filter `pd` has, `--pipeline-id <n>`, and its
machinery accepts a **number** and nothing else. A second filter cannot reuse it as written: the
flag name is a literal in the type, and the value is read with a `typeof value === "number"` test
that a string value silently fails — the filter would be accepted on the command line and then do
nothing, which is the worst of the available failures.

So this ticket generalises that machinery to carry a value the resource declares, then adds the
second filter through it. `--pipeline-id` must keep behaving exactly as it does today; it is the
regression test for the generalisation.

## Decisions taken

- **One flag with a value, not two bare flags.** `--admin global` and `--admin deal` read as one
  question with two answers, match `pd`'s existing value-carrying command flags, and extend to a
  third app without a third flag. Two boolean flags would double the manifest and `--help` surface
  for the same question.
- **The value vocabulary is `global` and `deal`, not `sales`.** It matches the field names ticket 27
  introduces, and the operator's UI. `sales` is not accepted as a synonym — one spelling per concept.
- **`list` only.** `get <id>` addresses one known user, and a filter that can make an addressed
  record vanish would turn a `get` into a `not_found` for a user who exists. This follows
  `--pipeline-id`, which `stages get` does not carry either.
- **Filtering happens where `--pipeline-id` filters** — over the whole cached list, before `--limit`
  bounds it. So `--admin global --limit 2` means "the first two admins", not "the admins among the
  first two users", and the summary's `complete` and `reason` keep the meaning ADR-0003 gives them.
- **A filter that matches nothing is a success, not an error.** Zero `record` lines and one summary
  with `emitted: 0`. ADR-0029 §5's no-survivors error is about records `pd` could not read, and a
  user who is simply not an admin was read perfectly.
- **No new request.** The filter runs over the same cached list ticket 27 already annotates.

## Acceptance

- [x] `pd users list --admin global` emits only records with `is_global_admin: true`
- [x] `pd users list --admin deal` emits only records with `is_deal_admin: true`
- [x] `pd users list` with no flag emits every user, as before
- [x] `pd users list --admin sales`, or any other unrecognised value, ends as a `usage` refusal that
      names `global` and `deal`
- [x] `--admin` with no value ends as a `usage` refusal
- [x] `pd users get <id> --admin global` is rejected as an unknown flag for that command
- [x] `--admin` composes with `--limit`: the filter runs first, and the summary reports `complete`
      and `reason` against the filtered list
- [x] A filter that matches no user exits 0 with `emitted: 0` and one summary line
- [x] `--admin` composes with `--fields`, including when the selected fields exclude the boolean the
      filter read
- [x] `pd manifest` and `pd users list --help` both list `--admin` with its two values
- [x] `pd stages list --pipeline-id <n>` still behaves exactly as before the generalisation, proven
      by its existing tests passing unchanged
- [x] A resource-declared filter value that the flag parser rejects can never reach the filter as a
      silently ignored value — the failure is a refusal, not a no-op
- [x] `AGENTS.md` documents the flag, its two values, and that it exists on `list` alone

## Comments

The `typeof value === "number"` test in today's filter path is the hazard this ticket has to remove
rather than copy. A filter flag that parses, then quietly does nothing, produces an answer that
looks right and is wrong — an agent reading the output has no way to tell it was never applied.
