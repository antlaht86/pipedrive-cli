# ADR-0022: Three credential-resolution edge cases ADR-0012 left open

Status: accepted
Date: 2026-08-13
Deciding input: implementation ticket [03](../../.scratch/pd-impl/issues/03-credential-resolution-and-auth-status.md), plus user direction ratifying the three points its review surfaced
Amends: [ADR-0012](0012-authentication-and-credential-resolution.md) §3 — an explicit `--token-file` that yields no token does not fall through, and an empty environment variable is unset
Amends: [ADR-0012](0012-authentication-and-credential-resolution.md) §5 — the sentence "finding no credential is not a failure" is scoped to the chain, not to a mistyped path
Confirms: [ADR-0012](0012-authentication-and-credential-resolution.md) §5's `--pretty` sentence, and names the ticket that owes it

## Context

[ADR-0012](0012-authentication-and-credential-resolution.md) settled the credential mechanism: an API
token, three tiers, first match wins, `auth` and exit 1 when nothing answers, and `pd auth status` as
the only auth command. Implementation ticket 03 built it and hit three questions the ADR does not
answer. Each was decided in code, and each was flagged in review as a deviation or an invention
rather than a reading — which is the signal that they belong in an ADR rather than in a ticket
comment. The spec's own rule is that where a ticket and an ADR disagree, **the ADR wins**; a decision
recorded only in a ticket is therefore a decision the next implementer is entitled to reverse.

None of the three is large. They are recorded because their alternatives are all defensible, and
because two of them are silent failure modes rather than visible ones.

## Decision

### 1. An explicit `--token-file` that yields no token is `usage`, exit 2 — and never falls through

If `--token-file <path>` names a file that does not exist, cannot be read, or holds only whitespace,
`pd` stops with `usage` and exit 2. It does **not** try `PD_API_TOKEN`, and it does not try the
credentials file.

**Why not fall through.** ADR-0012 §3 orders the tiers as it does to prevent one specific accident:
"a stored credential silently beating an explicitly exported one runs commands against the wrong
account." A `--token-file` that quietly loses to `PD_API_TOKEN` is that same accident with a shorter
fuse — the operator named a file precisely to be explicit, and a typo in the path would hand the run
to whatever the environment happened to hold. The failure is silent, and its symptom is data from the
wrong Pipedrive company.

**Why `usage` and not `auth`.** ADR-0012 §7 chose `auth` over exit 2 for a missing credential on one
argument: "no argument the caller can supply produces a credential", so exit 2's invitation to retry
with different arguments would send an agent into a futile loop. That argument does not hold here.
Fixing the path argument *does* produce a credential, and exit 2 is exactly the signal that says so.
The path is echoed back in the message, which ADR-0012 §3 permits — no argument value `pd` accepts is
sensitive, because §3 refuses `--token <value>`.

**The scope of ADR-0012 §5's "finding no credential is not a failure".** That sentence is about the
chain coming up empty, which is the configuration `pd auth status` exists to describe. A path that
does not resolve is not a configuration to describe; it is a mistyped argument. So
`pd auth status --token-file /typo` exits 2, while `pd auth status` with an empty chain exits 0 and
reports `found: false` — and `pd auth status --token-file <a good file>` reports the `token-file`
tier.

**A tier-3 file that is empty is not this case.** Nobody named it on the command line, so an absent or
empty `~/.config/pd/credentials` is simply a tier that did not answer. The chain continues, comes up
empty, and produces `auth` and exit 1 exactly as ADR-0012 §7 requires.

### 2. An environment variable that is empty or whitespace-only is unset

`PD_API_TOKEN=""` and `PD_API_TOKEN="   "` are treated as though `PD_API_TOKEN` were not exported at
all: the chain moves to the credentials file. The same rule governs `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `APPDATA` and `LOCALAPPDATA` — an empty value takes the platform default.

An exported-but-empty variable is what a shell script that meant to skip the variable actually
produces, and it is what a container runtime produces for an unset secret. The alternative —
`PD_API_TOKEN=""` counting as a credential — makes `pd` send an empty `x-api-token` header and turns
a configuration mistake into an `auth` failure from the API, one round trip later and one layer away
from its cause. There is no store-time validation to catch it (ADR-0012 §6), so the round trip is the
only thing that would.

The rule is applied by parsing rather than by inspection: one schema trims and requires a non-empty
result, and every tier — both files and the variable — passes through it. That is also the
[locked point 3](../../.scratch/pd-cli-design/map.md) boundary parse for this input.

### 3. `--pretty` on `pd auth status` is owed by the `--pretty` ticket, not by the auth ticket

ADR-0012 §5 ends: "`--pretty` renders the same fields as human text." That remains the decision.
`pd auth status --pretty` is a `usage` refusal until
[implementation ticket 18](../../.scratch/pd-impl/issues/18-pretty.md) lands, which is where the
aligned renderer, the flag's registration in the command table, the manifest's
`machine_readable: false` marking and the never-invoke instruction all live.

This is sequencing, not a change of contract. It is recorded here because the gap is visible from the
outside — an operator who reads ADR-0012 §5 and runs the flag today gets exit 2 — and because a
one-off human renderer written into the auth command would be a second implementation to delete when
ticket 18 arrives.

## Consequences

- **`AGENTS.md` gains one line** beside ADR-0012's credential paragraph: a `--token-file` that does
  not resolve is a usage error, and `pd` never silently falls back from it.
- **The manifest** must carry `usage` for `--token-file` in whatever form ticket 16 gives argument
  errors. No new `code` is minted: `usage` and `auth` already exist and ADR-0001's union is
  unchanged.
- **ADR-0012 is amended, not superseded.** Its three tiers, their order, the fingerprint, the
  write-capable statement, the refusal of `login`, profiles and store-time validation all stand.
- **§3 above is not a general rule about empty flag values.** It is about environment variables. What
  an empty `--fields=` or `--ids=` means belongs to the tickets that define those flags.
- **The `pd auth status` exit-code surface is now two values, not one**: 0 for any configuration it
  can describe, including an empty one, and 2 for an argument it cannot act on. It still never
  returns 1, and it still makes zero requests and writes nothing.
