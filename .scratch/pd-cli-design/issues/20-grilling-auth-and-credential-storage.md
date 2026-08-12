# Auth mechanism, credential storage, and account selection

Type: grilling
Status: resolved

Blocked by: 05, 08

## Question

Which authentication mechanism, where does the credential live, and how does the user avoid supplying it on every invocation?

- API token or OAuth, on ticket 05's findings. Weigh setup cost, read-only scoping, revocability, and — decisively if ticket 05 found a difference — how each attributes against the shared daily budget.
- Where the credential is stored, on ticket 08's findings. OS keychain, permission-restricted config file, environment variable, or a precedence chain over several. The user's requirement is explicit: entered once, not on every invocation.
- How it gets there. Is there a `pd auth login` style command, and is a command that writes a credential file compatible with a tool whose surface is read-only? Argue it — writing local configuration is not writing to the CRM, but the distinction must be stated, not assumed.
- Whether the credential is validated at store time so a bad paste fails immediately.
- Named profiles: does the user select an account, a project, or a token — and what is the unit? Ticket 05 establishes whether a token is per-user or per-company, which decides whether a profile is a company account, a credential, or both.
- How the active profile is selected: a flag, an environment variable, a default recorded in config, or the working directory. A per-directory default would let an agent working in a repo get the right account without being told — is that useful or surprising?
- What happens with no credential at all: which error variant from ticket 09, which exit code, and what the message tells an agent to do about it.
- Leakage: confirm the credential cannot reach stdout, stderr diagnostics, the ticket 14 cache, or a `--pretty` dump. Redaction is a rule the client module enforces, not a habit.
- Whether the company base URL is derived from the credential or stored alongside it.

Record as an ADR.

## Context added while resolving other tickets

- **A conflict to surface deliberately, not inherit silently.** [Storing API credentials safely for a local CLI](08-research-secure-credential-storage.md) recommends **exit 2** when no credential is found anywhere in the precedence chain, reading it as a usage problem. [ADR-0001](../../../docs/adr/0001-error-model-and-exit-codes.md) defines `auth` — credential missing, invalid or revoked — as **exit 1**. Both are defensible: a missing credential is arguably the caller invoking the tool wrongly, or arguably a runtime condition the caller cannot fix from argv. Decide it here rather than letting the implementation pick.
- [Pipedrive authentication: API token versus OAuth](05-research-auth-mechanisms.md) found that an API token **cannot be scoped read-only at all**, while OAuth has real `:read` scopes. That makes this ticket's choice partly a safety decision rather than purely an ergonomic one — see [How the read-only property is actually enforced](23-grilling-read-only-enforcement.md), which is blocked on this one.
- [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) **cut `GET /users/me` (`getCurrentUser`) out of the generated surface**, along with six other `users` endpoints. This ticket is where it would come back — validating a credential at store time, or a `pd auth verify`, is the natural caller of `/users/me`, and ADR-0005 §2 already noted it costs 2 tokens and deliberately did not spend it. Re-admitting the operation is a decision this ticket may take, but it changes ADR-0007's generation filter and must say so.
- ADR-0007 also fixed that **both generated clients are constructed by the one wrapper and share one `guardedFetch`**, keyed on one credential. Whatever profile unit this ticket settles on applies to v1 and v2 together; there is no per-version credential.

## Answer

Full detail in [ADR-0012](../../../docs/adr/0012-authentication-and-credential-resolution.md).

**API token, and the read-only property is now openly `pd`'s own problem.** OAuth was rejected on setup cost — research 05 found Authorization Code flow only, so a local CLI would need every user to register their own Marketplace app and would ship a `client_secret` that is not secret. Its 4× burst headroom buys little against [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md)'s deliberately half-sized gate. The consequence is stated rather than softened: the stored credential is fully write-capable, no layer below `pd` prevents a write, and [ticket 23](23-grilling-read-only-enforcement.md) inherits the entire mechanism with no help.

**Three tiers, not four: `--token-file` → `PD_API_TOKEN` → `~/.config/pd/credentials` (0600) → `auth`, exit 1.** Never a `--token <value>` flag, so no argument `pd` accepts is ever sensitive.

**No `pd auth login`, and cutting it is what removed the keychain.** `Bun.secrets` is a programmatic API, so without a command to write the entry the tier is unreachable — and dropping it means no `Bun.*` API is required by any decision so far, which keeps research 07's plain-npm-package distribution open for [ticket 21](21-grilling-distribution.md). `pd auth status` survives as the only auth command: zero requests, zero writes, reports the tier and a SHA-256 fingerprint that is literally [ADR-0005](../../../docs/adr/0005-cache-design.md) §2's cache directory name.

**Both recorded conflicts resolved.** Exit code: ADR-0001's `auth`/exit 1 beats research 08's exit 2, because no argument the agent can supply produces a credential and exit 2 invites a futile retry. Profiles: refused entirely — research 08 wanted them to key the keychain (gone) and the cache (already keyed by credential hash, deliberately, because a profile name is not an account identity).

**`GET /users/me` stays out.** No store-time validation, so ADR-0007's generation filter is unchanged, and the base URL is fixed at `api.pipedrive.com` rather than the per-company routing domain.

**One prior ADR was wrong and is corrected.** ADR-0001 justified URL redaction with "the token may travel as a query parameter"; research 05 found no such parameter in either spec. The rule survives on a different ground — query strings carry user-supplied search and filter values, which are company data.
