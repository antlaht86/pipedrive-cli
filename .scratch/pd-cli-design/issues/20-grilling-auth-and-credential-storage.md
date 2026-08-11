# Auth mechanism, credential storage, and account selection

Type: grilling
Status: open

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
