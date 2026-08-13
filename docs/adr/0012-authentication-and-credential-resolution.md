# ADR-0012: Authentication, credential resolution, and `pd auth status`

Status: accepted
Date: 2026-08-12
Deciding ticket: [Auth mechanism, credential storage, and account selection](../../.scratch/pd-cli-design/issues/20-grilling-auth-and-credential-storage.md)
Amends: [ADR-0009](0009-command-surface-and-manifest.md) §8 — `pd auth status` is a third group outside the grammar
Corrects: [ADR-0001](0001-error-model-and-exit-codes.md) §Context — the query-parameter premise behind URL redaction is false
Supersedes: [research 08](../../.scratch/pd-cli-design/research/08-secure-credential-storage.md) §7 on named profiles, the keychain tier, and the exit code for a missing credential

## Context

Two research tickets fed this decision and they disagree with each other in one place and with a
prior ADR in another.

[Research 05](../../.scratch/pd-cli-design/research/05-auth-mechanisms.md) established the fact that
dominates everything below: **an API token cannot be scoped read-only at all.** The `api_key` security
scheme carries no scopes — every `security:` entry in both specs is literally `- api_key: []` — and
the same token authorises `DELETE /deals/{id}` exactly as it authorises `GET /deals`. OAuth, by
contrast, offers real `:read` scopes for every resource `pd` touches, and roughly 4× the burst
headroom on its own lane. Neither mechanism protects the shared daily budget: both draw from the same
company pool.

[Research 08](../../.scratch/pd-cli-design/research/08-secure-credential-storage.md) established that
`Bun.secrets` reaches the OS keychain with no npm dependency, and recommended a four-tier precedence
chain, named profiles, and store-time validation via `GET /users/me`.

The map's own words: "an agent must be unable to damage the CRM through this tool no matter what it
does." Research 05 makes that a statement about `pd`'s code rather than about the credential, and this
ADR is where that is accepted rather than papered over.

## Decision

### 1. API token, in the `x-api-token` header. No OAuth, ever

`pd` authenticates with a Pipedrive API token, sent in the `x-api-token` request header on both the v2
client and the narrow v1 client of [ADR-0007](0007-the-narrow-v1-users-client.md).

OAuth was rejected on setup cost, not on merit. Research 05 found Pipedrive offers **Authorization
Code flow only** — no device flow, no client-credentials grant. A locally installed CLI on that flow
needs a registered Marketplace application, a `client_secret`, a redirect URI and a browser round
trip, and a `client_secret` shipped inside a distributed CLI is not a secret. The realistic form is
"every user registers their own Pipedrive app before running one command", against a token that is one
copy-paste out of Company settings → Personal preferences → API.

The burst headroom OAuth would have bought (80–480 req/2 s versus 20–120) is worth little here:
[ADR-0011](0011-concurrency-and-retry.md) §3 found concurrency nearly useless because the dominant
cursor walk is sequential, and its gate is deliberately set at half the smallest documented window
regardless of what the credential could sustain.

### 2. The consequence, stated plainly: the read-only property rests entirely on `pd`'s code

The stored credential is fully write-capable. Nothing outside `pd` prevents a write. The map's safety
property is therefore not a property of the credential, the transport, or Pipedrive's permission
model — it is a property of the generated client's operation set and of the one wrapper module that
[locked point 7](../../.scratch/pd-cli-design/map.md) requires all traffic to pass through.

This ADR does not decide how that is enforced; [ticket 23](../../.scratch/pd-cli-design/issues/23-grilling-read-only-enforcement.md)
does, and it inherits the whole burden with no help from the auth layer. Two mitigations exist but are
account administration rather than tool design, and `AGENTS.md` should name them for the security-conscious
operator: a Pipedrive permission set can restrict the human user the token belongs to, and the token can
be regenerated to revoke it.

### 3. The precedence chain has three tiers, first match wins

1. **`--token-file <path>`** — read the token from the named file. Explicit, per-invocation.
2. **`PD_API_TOKEN`** — the container, CI and agent-harness path.
3. **`$XDG_CONFIG_HOME/pd/credentials`**, defaulting to `~/.config/pd/credentials`, mode `0600`.
4. Otherwise `auth`, exit 1 — see §7.

**There is no `--token <value>` flag, in any form.** argv is readable by every other user on the
machine; the environment is not. This also means no argument value `pd` ever accepts is sensitive, so
the usage errors of [ADR-0001](0001-error-model-and-exit-codes.md) can echo the offending argument
back without a redaction rule.

**The environment variable sits above the file** because the reverse is astonishing: a stored
credential silently beating an explicitly exported one runs commands against the wrong account. `gh`,
Stripe and AWS all order it this way.

**Tier 3 is read-only to `pd`.** The file is written by a human, with an editor, once. `pd` reads it
and never creates, updates or deletes it. If it exists with permissions looser than `0600`, `pd` emits
one `warning` line naming the file and proceeds — the token is already exposed and refusing to run
does not unexpose it.

### 4. There is no keychain tier, and that is what keeps the cheap distribution open

*Amended by [ADR-0021](0021-distribution-build-from-source.md) §2. **The title's reasoning no longer
holds**: the cheap npm distribution this section protected is gone, `pd` ships as a compiled Bun
binary, and `Bun.*` APIs are permitted in `src/**` again. The decision below is unchanged, because it
never rested only on the distribution argument — §5 declines to have a command that puts a credential
anywhere, which leaves the keychain tier unreachable whatever the API surface allows. Read the second
half of this section as history rather than as a live constraint.*

Research 08's tier 3, `Bun.secrets`, is cut. The reason is mechanical: `Bun.secrets` is a programmatic
API, so the only way a credential gets into the keychain is a `pd` command that puts it there. §5
declines to have one, which leaves the tier unreachable.

The consequence is worth more than the tier. `Bun.secrets` is a `Bun.*` API, and
[research 07](../../.scratch/pd-cli-design/research/07-bun-distribution.md) found the plain npm
package — a few hundred kilobytes, no code signing, no notarization — is available **only if `pd`
avoids `Bun.*` APIs**. Refusing the keychain keeps that option open for [ticket 21](../../.scratch/pd-cli-design/issues/21-grilling-distribution.md),
which is otherwise choosing between a 17–28 MB compiled binary and a browser-download path that needs
Apple notarization.

Research 08 §9 point 9 also warned against overselling the keychain: if `pd` ships as a Bun script,
macOS grants it no isolation from any other Bun script on the machine.

### 5. `pd auth status` is the only auth command. There is no `login`, `logout` or `verify`

`pd` never writes a credential anywhere. The read-only claim needs no qualification about local files,
because there is no local file `pd` authors.

`pd auth status` makes **zero network requests** and writes nothing. It reports:

- whether a credential was found at all;
- which tier it came from — `token-file`, `env`, or `config-file` — and, for the file tiers, the path;
- the credential **fingerprint**: the first 16 hex characters of the SHA-256 of the token, which is
  exactly the value [ADR-0005](0005-cache-design.md) §2 uses as the cache directory name. A human can
  therefore match a running configuration to a cache directory without `pd` printing anything
  reversible;
- whether a cache directory exists for that fingerprint.

It never prints the token, and no `--show-token` flag exists.

**Finding no credential is not a failure of `pd auth status`.** It exits 0 and reports the absence in
its `found` field, because the command's job is to describe the configuration rather than to use it —
a diagnostic that exits non-zero when the thing it diagnoses is the problem is useless for
diagnosing. §7's `auth`/exit 1 applies to every command that needs a credential, which this one does
not.

A `login` was rejected as the thing that would have created the keychain tier, and with it the `Bun.*`
dependency of §4. A `verify` — a live `GET /users/me` — was rejected separately in §6.

**Output shape.** `pd auth status` emits **one JSON object** on stdout, not an NDJSON stream. This is
the same exception [ADR-0009](0009-command-surface-and-manifest.md) §7 grants `pd manifest`, on the
same grounds: it is not a record stream, it cannot be partial, and there is nothing for a trailer to
say about it. `--pretty` renders the same fields as human text.

### 6. No store-time validation, and `GET /users/me` stays out of the generated surface

Research 08 recommended validating a pasted token once against `GET /users/me` (2 tokens). With no
`login` command there is no store time to validate at, and a `pd auth verify` was declined: it buys
one clearer error message for a mistyped paste, at the cost of re-admitting an operation
[ADR-0007](0007-the-narrow-v1-users-client.md) deliberately cut. A bad token surfaces as `auth` on the
first real command, which is a one-time annoyance rather than a standing cost.

**[ADR-0007](0007-the-narrow-v1-users-client.md)'s generation filter is therefore unchanged.**
`GET /users` remains the only v1 operation in the generated surface, and `getCurrentUser` stays out
along with the other six `users` endpoints.

### 7. A missing credential is `auth`, exit 1 — [ADR-0001](0001-error-model-and-exit-codes.md) wins

Research 08 §7 suggested exit 2 on the reading that a missing credential is a usage problem. It is
not, for the consumer that matters. Exit 2 means "you invoked this wrongly" and invites a retry with
different arguments; no argument the agent can supply produces a credential. A human must go and get
one. That is precisely what ADR-0001's `auth` variant means — "credential missing, invalid or
revoked", caller's response "a human must supply one" — and it needs no third state.

The `message` accompanying it names every tier searched, in order, and the config path it looked at,
so the human reading the agent's transcript can act without consulting documentation.

### 8. There are no named profiles

No `--profile` flag, no `PD_PROFILE` variable, no sections in the credentials file. The file holds one
token. Switching accounts means a different `--token-file` or a different `PD_API_TOKEN`.

Research 08 recommended the AWS/Stripe profile model, but its stated purpose was to key two things:
the keychain entry, which §4 removed, and the custom-field cache — which
[ADR-0005](0005-cache-design.md) §2 already keys by a hash of the credential precisely *because* a
profile name is a string the user invents rather than an account identity. Two accounts on one machine
cannot contaminate each other whether or not profiles exist. What remains would be one file holding
several tokens, which is also one file leaking several tokens.

The per-directory default the ticket asked about is moot: with no profiles there is nothing to
default.

### 9. The base URL is fixed at `https://api.pipedrive.com`

Pipedrive's prose documentation prefers the per-company form,
`https://<company>.pipedrive.com/api/v2/...`, for data-centre routing. `pd` does not use it. Learning
the company domain requires `GET /users/me`, which §6 declined, and both OpenAPI specs declare the
generic host as their server — Pipedrive's own documented example for *discovering* the domain calls
it. The cost is a routing hop; the alternative is an operation, a stored value, and a staleness
question, for latency the tool does not otherwise optimise.

Nothing is stored alongside the credential. The credentials file contains a token and nothing else.

### 10. Redaction is structural, and one prior justification for it was wrong

The discipline of research 08 §8 is adopted whole:

| Surface | Rule |
| --- | --- |
| The token string | Exists only inside the one client module of locked point 7. Nothing else ever holds it. |
| Error values | Carry method, path, status and request id. Never headers. |
| stderr diagnostics | Headers are printed from an **allowlist**, never a denylist. |
| Cache keys | The SHA-256 prefix, never the token. |
| Cache contents | Response bodies only. Request headers are never serialised into an entry. |
| `--pretty` | Renders typed domain values. Never `JSON.stringify` of a config or client object. |
| `pd auth status` | The fingerprint is a one-way digest. There is no flag that prints the token. |
| Usage errors | No argument value is sensitive, because §3 refuses `--token <value>`. |

**The correction.** [ADR-0001](0001-error-model-and-exit-codes.md) §Context justifies redacting URLs
before they enter an error's `details` with the claim that "an API token may be transmitted as a query
parameter, so a request URL is credential-bearing." Research 05 found no `api_token` query parameter
in either OpenAPI spec — `grep -c api_token` returns zero in both — and the documented transport is
the header alone. The premise is false. **The rule survives** on the independent ground that a request
URL can carry a user-supplied search term or filter value, which is company data that has no business
on an agent's stdout by default. ADR-0001 is amended to say so.

## Consequences

- **[Ticket 23](../../.scratch/pd-cli-design/issues/23-grilling-read-only-enforcement.md) is unblocked
  and inherits the full weight.** There is no credential-level, transport-level or account-level
  guarantee behind it. Whatever it decides is the entire mechanism.
- **[Ticket 21](../../.scratch/pd-cli-design/issues/21-grilling-distribution.md) gains a freedom
  rather than a constraint.** With `Bun.secrets` refused, no decision so far requires a `Bun.*` API,
  so the plain npm package remains on its table. It should verify that nothing else in the design has
  reached for one before relying on this.
- **[ADR-0009](0009-command-surface-and-manifest.md) §8 is amended.** Its sentence that `pd manifest`
  and the two `pd cache` commands are "the complete set of exceptions" now names a third group,
  `pd auth status`, on the same reasoning: the grammar governs *resources*, and a credential is not
  one. `pd manifest` lists it, and it joins `pd manifest` as an emitter of a single JSON object rather
  than an NDJSON stream — the third such exception to [ADR-0002](0002-output-format.md) after `--help`.
- **[ADR-0001](0001-error-model-and-exit-codes.md) is amended twice**: the query-parameter premise is
  corrected per §10, and `auth`'s membership of exit 1 is confirmed as covering the
  credential-not-found case explicitly, closing the conflict the ticket recorded.
- **[ADR-0007](0007-the-narrow-v1-users-client.md) is untouched.** The ticket flagged that re-admitting
  `getCurrentUser` would change its generation filter; §6 declined to.
- **[ADR-0005](0005-cache-design.md) §2 is confirmed rather than changed.** Its choice to key the cache
  by credential hash instead of profile name is what makes §8's refusal of profiles safe, and its
  fingerprint is now also user-visible through `pd auth status`.
- **`AGENTS.md` gains**: the three-tier chain in order, the `PD_API_TOKEN` name, the `~/.config/pd/credentials`
  path and its `0600` requirement, the `auth`/exit 1 contract with the message that names every tier,
  `pd auth status`, and one honest paragraph saying the token is write-capable and that a permission
  set on the Pipedrive user is the only account-level restriction available.
- **One documentation risk to carry**: a user who reads "read-only tool" and hands `pd` a token
  belonging to an administrator has given a fully privileged credential to a program whose safety
  rests on its own correctness. The `AGENTS.md` paragraph above exists for that reader.
