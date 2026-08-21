# ADR-0033: The live identity probe

Status: accepted
Date: 2026-08-21
Amends [ADR-0012](0012-authentication-and-credential-resolution.md) §6: the rejection of a live `GET /users/me`
Amends [ADR-0007](0007-the-narrow-v1-users-client.md) §1: the v1 generation filter grows from one operation to two

## Context

[ADR-0012](0012-authentication-and-credential-resolution.md) §6 declined a `pd auth verify`. Its
reasoning is quoted whole, because the amendment turns on what it says and on what it does not:

> Research 08 recommended validating a pasted token once against `GET /users/me` (2 tokens). With no
> `login` command there is no store time to validate at, and a `pd auth verify` was declined: it buys
> one clearer error message for a mistyped paste, at the cost of re-admitting an operation ADR-0007
> deliberately cut. A bad token surfaces as `auth` on the first real command, which is a one-time
> annoyance rather than a standing cost.

That paragraph prices exactly one thing: **validity**. It weighs a clearer error message against a
re-admitted operation, and on validity alone it is still right — a dead token does surface as `auth`
on the first real command, and paying two tokens up front to learn the same fact sooner is a poor
trade.

It never prices **identity**. "Which account is this token pointed at, and who am I on it" is a
question `pd` cannot answer today by any route. `GET /users` returns the whole collection and nothing
in it marks which row is the caller; the fingerprint names the credential without naming the person;
[ADR-0012](0012-authentication-and-credential-resolution.md) §8's "switching accounts means a
different `--token-file`" makes two tokens on one machine the expected configuration rather than an
exotic one. The unanswered question is therefore not the one §6 rejected, and §6's silence on it is a
gap rather than a decision.

`GET /v1/users/me` answers both at once. Research 05 §5 records it verbatim from the spec:
`x-token-cost: 2`, `operationId: getCurrentUser`, and a response carrying `id`, `name`, `email`,
`active_flag`, `timezone_name`, `role_id`, `permission_set_id`, `company_id`, `company_name` and
`company_domain`.

## Decision

### 1. `pd auth whoami` is a new command, and `pd auth status` does not change

The live answer lands in a **new** command rather than inside `pd auth status`.

[ADR-0012](0012-authentication-and-credential-resolution.md) §5's "zero network requests" survives
untouched, and so does everything that rests on it: `pd auth status` still describes a configuration
rather than using it, still answers on a plane, still exits 0 when it finds nothing, and still has an
exit surface of 0 and 2 alone ([ADR-0022](0022-credential-resolution-edge-cases.md) §1).

Widening `pd auth status` was rejected on that ground. A `--live` flag was rejected on a worse one:
it would give one command two output shapes and two exit surfaces selected by a flag, which is the
hardest contract for an agent to read.

The cost accepted is that the `auth` subtree now holds two commands with two different grammars, and
a human must know which one they want. The names carry it: `status` describes, `whoami` asks.

### 2. `whoami` is a data command, so the error model already fits

`pd auth whoami` **uses** the credential. That single fact hands it
[ADR-0012](0012-authentication-and-credential-resolution.md) §7 unamended — a credential that is
missing, invalid or revoked is `auth`, exit 1 — and with it the whole of
[ADR-0001](0001-error-model-and-exit-codes.md). No new exit-code rule is written for this command,
and none is needed.

The three-valued answer the question really has falls out of the variants that already exist:

| What happened | `code` | Exit |
| --- | --- | --- |
| The token is dead, revoked, or nothing was found | `auth` | 1 |
| The network or Pipedrive did not answer | `upstream` | 1 |
| The burst window is exhausted, or the daily budget is | `rate_limited` / `budget_exhausted` | 3 |
| The token works | — | 0 |

### 3. There is no `works` field

Success **is** the proof. A record on stdout means the credential authenticated; there is no boolean
saying so.

A `works: true` field would be constant, because the branch that would set it to `false` has no
record to attach it to. A caller distinguishes "dead token" from "no network" by reading `code`,
which [ADR-0001](0001-error-model-and-exit-codes.md) already requires it to read, and which carries
strictly more information than a boolean can.

The alternative — exit 0 always, `works: false` on a rejected token, in the manner of `pd auth
status`'s `found` — was rejected. It would make `whoami` a diagnostic rather than a data command,
which costs an explicit exception to §7, and it would then have to fold a network failure into the
same boolean, where it does not fit: a token whose validity is *unknown* is not a token that does not
work.

### 4. The record is a `users` record plus a company block plus the local join

One NDJSON line, carrying three groups of fields:

- **The user, shaped exactly as `pd users` shapes one**: `id`, `name`, `email`, `active_flag`,
  `timezone_name`. An agent holding a deal's `owner_id` can compare it against `whoami`'s `id`
  without a format conversion, which is the comparison the question "is this mine" actually is.
- **The company**: `company_id`, `company_name`, `company_domain`. This is the half of "whose token is
  this" that no user record has ever carried.
- **The local join**: `tier` and `fingerprint`. This is the pair that neither command can produce
  alone — `pd auth status` prints a fingerprint and no name, `/users/me` returns a name and no
  fingerprint. With two tokens on one machine it is what says which cache directory belongs to whom.
  The fingerprint is derived and not reversible ([ADR-0012](0012-authentication-and-credential-resolution.md) §5),
  so printing it beside an identity leaks nothing the fingerprint did not already print alone.

`is_global_admin` and `is_deal_admin` are **conditional**. `pd` derives them from the `access` array
([ADR-0007](0007-the-narrow-v1-users-client.md) §3, amended by ticket 27), and the `/users/me`
response schema does not declare `access`. Where `access` is absent the two fields are **omitted**
rather than emitted as `false`: [ADR-0020](0020-value-formatting-and-absence.md) governs absence, and
`false` here would state that the caller is not an admin, which is not what was learned.

A pass-through record in the manner of [ADR-0029](0029-the-record-interior-passes-through.md) was
rejected. `pd users` is the one resource whose output stays closed ([ADR-0029](0029-the-record-interior-passes-through.md) §2),
and a `whoami` line that did not match a `pd users` line would defeat the comparison in the first
bullet.

### 5. The output is NDJSON with a trailer, and the flags are `--pretty` and `--fields`

[ADR-0009](0009-command-surface-and-manifest.md) §7's rule is that data commands emit NDJSON, and its
exception for `pd manifest` and `pd auth status` rests on three grounds: not a record stream, cannot
be partial, nothing for a trailer to say. `whoami` meets two of the three and fails the third — it
dispatches a request, so the trailer has a `requests` count to report and an `error` trailer is a
reachable outcome.

`pd users get <id>` is the precedent, and it is exact: one record, NDJSON, trailer.
`--pretty` and `--fields` work there and work here, for the same reasons and with no new rules. The
ceremony of a trailer on a one-line stream is accepted as the price of one parser across every
command that makes a request.

### 6. `whoami` never touches the cache

It neither reads a cache entry nor writes one, and `--no-cache` changes nothing about it.

A cached "your token works" is a statement about a request that is not being made, which is to say it
is false whenever it matters. And caching buys nothing even for the identity half: the live request
is required for validity regardless, and it returns the identity in the same response.

`whoami` is therefore neither a cached resource nor a live resource in
[ADR-0005](0005-cache-design.md)'s sense — the closed list of eight cache entries is unchanged, and
this command is simply outside it.

### 7. The v1 generation filter grows to two operations, and stops there

[ADR-0007](0007-the-narrow-v1-users-client.md) §1's filter becomes
`/^GET \/users$/` and `/^GET \/users\/me$/`. `getCurrentUser` re-enters the generated surface; the
other six operations the exploratory filter once pulled in — `getUser`, `findUsersByName`,
`getUserFollowers`, `getUserPermissions`, `getUserRoleAssignments`, `getUserRoleSettings` — stay out,
and the filters stay anchored so they cannot drift back in.

The hand-written-wrapper branch stays closed: [ADR-0007](0007-the-narrow-v1-users-client.md) §1's
locked point 2 admits no exception, and this ADR does not take one.

`pd`'s read-only property is unaffected. `GET /users/me` is a `GET`, and
[ADR-0013](0013-read-only-enforcement.md)'s guard sees it as it sees every other request.

## Consequences

- The `auth` subtree holds two commands whose grammars differ: `pd auth status` emits one JSON object
  and never exits 1; `pd auth whoami` emits NDJSON with a trailer and exits 1 on a rejected
  credential. The manifest publishes both, so an agent discovers the difference rather than inferring
  it.
- Every `pd auth whoami` invocation spends 2 tokens of the shared daily budget and one burst-window
  request. It is the only command in `pd` whose entire purpose is to spend them, and it is the only
  command with no cache path to avoid them.
- The `access` question in §4 is settled by observation, not by this ADR. The first real `/users/me`
  response decides whether the two derived admin fields ever appear.
