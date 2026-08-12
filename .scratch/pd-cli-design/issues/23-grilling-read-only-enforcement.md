# How the read-only property is actually enforced

Type: grilling
Status: open

Blocked by: 18, 20

## Question

The map states as a safety property that an agent must be unable to damage the CRM through this tool, no matter what it does. [Pipedrive authentication: API token versus OAuth](05-research-auth-mechanisms.md) established that an API token cannot be scoped read-only at all — the same credential that authorises `GET /deals` authorises `DELETE /deals/{id}`, and Pipedrive offers no credential-level restriction. So with an API token the property rests entirely on `pd`'s own code being correct.

That is a weaker guarantee than the map assumed when it was charted. Decide what actually enforces it.

- Whether write operations are excluded at **generation** time, so no write function exists in the codebase to call by accident. [What `@hey-api/openapi-ts` can generate and how it can be wrapped](06-research-hey-api-capabilities.md) section 4 covers restricting generation to a read-only surface — establish whether the exclusion is reliable and what it costs.
- Whether the single client module additionally refuses any non-GET method at runtime, as a second independent layer. Belt and braces, or redundant weight?
- Whether the exclusion is **verified** rather than asserted — a test or a CI check that fails if a write operation reappears in the generated output after a regeneration, or if a non-GET call site is introduced.
- What the answer is for the second generated client that [Which resources are v1-only, and what the v2 spec omits](04-research-v1-v2-resource-coverage.md) says Class B resources would need. The same guarantee must hold there, from a lower-quality spec.
- Whether choosing OAuth with `:read` scopes changes the answer, since that would move enforcement from our code to Pipedrive's server. If it does, this ticket and the auth decision are coupled more tightly than they look — say so explicitly rather than deciding them apart.
- What the tool tells a caller that asks for something it cannot do, and whether the read-only guarantee is legible in the command manifest rather than only in prose.
- Whether a local write — storing a credential, writing a cache entry — is inside or outside this property, and how the spec words the distinction so it does not read as a loophole.

Record as an ADR. This is a safety property, so argue it as one: state what would have to go wrong for a write to reach Pipedrive, and how many independent things that is.

## Context added while resolving other tickets

- **[ADR-0012](../../../docs/adr/0012-authentication-and-credential-resolution.md) settled the auth question against you.** `pd` uses an API token, so bullet 5 above is answered: OAuth `:read` scopes are not coming, no server-side enforcement exists, and this ticket owns the entire mechanism. ADR-0012 §2 says so in those words.
- **The credential is fully write-capable and may belong to an administrator.** ADR-0012 §2 named the only account-level mitigations — a Pipedrive permission set on the human user the token belongs to, and regeneration as revocation — and both are account administration, outside `pd`. It also recorded a documentation risk this ticket may want to own: a user who reads "read-only tool" and supplies an admin token has handed a fully privileged credential to a program whose safety rests on its own correctness.
- **Bullet 7 is half-answered, and in `pd`'s favour.** ADR-0012 §5 refused `pd auth login`, so `pd` writes no credential at all. The only local write left is the cache. [ADR-0009](../../../docs/adr/0009-command-surface-and-manifest.md) §6 already words that distinction — read-only is a property of what `pd` does to the *Pipedrive API*, so `pd cache clear` deleting local files is not a violation; this ticket only has to confirm it rather than invent it.
- **Bullet 4 shrank.** [ADR-0007](../../../docs/adr/0007-the-narrow-v1-users-client.md) cut the v1 client to one operation, `GET /users`, and ADR-0012 §6 declined to re-admit `getCurrentUser`. The "second generated client from a lower-quality spec" is now a single GET.
