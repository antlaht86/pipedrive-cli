# ADR-0013: How the read-only property is enforced

Status: accepted
Date: 2026-08-12
Deciding ticket: [How the read-only property is actually enforced](../../.scratch/pd-cli-design/issues/23-grilling-read-only-enforcement.md)
Extends: [ADR-0001](0001-error-model-and-exit-codes.md) — adds a twelfth variant, `write_blocked`
Extends: [ADR-0012](0012-authentication-and-credential-resolution.md) §5 — `pd auth status` gains two fields
Confirms: [ADR-0009](0009-command-surface-and-manifest.md) §6 — the scope wording is adopted unchanged

## Context

The map states as a safety property that an agent must be unable to damage the CRM through this
tool, no matter what it does. When the map was charted, that read as a claim about the system.
[ADR-0012](0012-authentication-and-credential-resolution.md) §2 reduced it to a claim about one
codebase: `pd` authenticates with an API token, an API token cannot be scoped, and the same
credential that authorises `GET /deals` authorises `DELETE /deals/{id}`. Pipedrive enforces nothing.

So this ADR is not a design choice among several. It is the whole mechanism, and it has to be argued
as a safety property: what would have to go wrong for a write to reach Pipedrive, and how many
independent things that is.

Four facts fixed the ground.

**The generation filter works, verified against the real spec.** Research 06 §4 ran
`parser.filters.operations.include: ['/^GET /']` against Pipedrive's OpenAPI v2 document and counted
the generated output: 66 `.get<` call sites, and zero `.post<`, `.put<`, `.delete<` or `.patch<`.
Not an argument that write functions would be unreachable — a measurement that they do not exist.

**The generated seam has a documented hole.** Research 06 §1.5: `RequestOptions extends Config`, so
`fetch` and `baseUrl` are accepted per call, and `...options` is spread *after* `url` in every
generated function. A caller inside the wrapper can therefore supply its own `fetch`, or overwrite
the URL, and route around whatever the module's own client does.

**One layer research 06 recommends does not exist.** Its §4 closes by suggesting two extra layers:
a request interceptor rejecting non-GET, and "a Pipedrive API token scoped read-only". The second
is not available. Research 05 established that Pipedrive offers no credential-level restriction at
all, and ADR-0012 §2 decided on that basis. The layer is named here only so that the count in §7 is
not quietly inflated by a layer nobody can build.

**Half the ticket was already answered elsewhere.** ADR-0012 §2 closed the OAuth question — server-side
enforcement is not coming. ADR-0012 §5 removed `pd auth login`, so `pd` writes no credential.
ADR-0009 §6 already worded the local-write distinction and put read-only on three channels.
ADR-0007 cut the v1 surface to a single operation, `GET /users`. What remained to decide is below.

## Decision

### 1. Four layers, and every one of them is `pd`'s own code

| # | Layer | Stops | Survives |
| --- | --- | --- | --- |
| a | Generation filter `include: ['/^GET /']` | A write function existing to be called | Regeneration, because it is configuration and not an edit |
| b | Non-GET refusal in the single client's custom `fetch` | A write assembled by hand inside the wrapper | A wrapper bug, because it sits below the wrapper |
| c | ESLint `no-restricted-imports` on `**/generated/**` outside `src/lib/pipedrive/**` | A call site reaching the generated SDK directly | Refactoring, because it is a path rule and not a convention |
| d | CI check on the generated output and the call sites | (a) or (b) silently disappearing | Time, which is the layer the other three lack |

Layer (b) is **not** redundant with (a), and the reason is specific rather than a general appeal to
defence in depth. Research 06 §1.5's per-call `fetch` and `baseUrl` overrides, and the `...options`
spread that lands after `url`, mean a bug inside the wrapper module can construct a request that
layer (a) never sees. Layer (b) is the only thing below that.

Layer (b) inspects the request the runtime is about to issue — method and resolved URL — rather than
trusting the argument it was handed, because the point of the layer is to catch a caller that lied.

### 2. Verification is a CI gate that fails hard, not a warning

Layer (d) is two checks, and a failure blocks the merge. A warning would make the safety property
depend on somebody reading a log.

1. **Generated output.** After `openapi-ts` runs, assert zero non-GET operations in `sdk.gen.ts` for
   both generated clients. Research 06 §4's grep is the check; the assertion is that the count is
   zero, not that it is small.
2. **Call sites.** The ESLint rule of layer (c) runs in CI, so a new import of `**/generated/**`
   from outside the wrapper fails the build rather than merely offending a reviewer.

A regeneration that reintroduces a write operation is the exact scenario this exists for: the spec
is Pipedrive's, it changes without notice, and the person running the regeneration script is not
necessarily thinking about the safety property that day.

Layer (b) additionally gets a unit test that drives a non-GET request through the client and asserts
the `write_blocked` error of §4 — the guard is exercised, not merely present.

### 3. The v1 client gets the same treatment, and it costs nothing

[ADR-0007](0007-the-narrow-v1-users-client.md) cut the v1 footprint to one operation, `GET /users`.
The ticket asked whether a lower-quality spec weakens the guarantee. It does not, because the same
filter applies to the v1 generation and the surface it produces is one GET. Layer (b) is shared —
both generated clients are driven by the one client module, which is locked note 7 — so the runtime
guard covers v1 without a second implementation. The CI check of §2 asserts zero non-GET operations
in **both** generated outputs.

The lower quality of the v1 spec is a *validation* risk, owned by
[ADR-0006](0006-validation-placement-and-rejection.md). It is not a read-only risk.

### 4. A blocked write is `write_blocked`, exit 1 — [ADR-0001](0001-error-model-and-exit-codes.md) gains a twelfth variant

If layer (b) ever fires, `pd` has a bug. The caller still has to see something, and that something
is a typed error rather than a crash.

```json
{"type":"error","code":"write_blocked","message":"pd attempted a non-GET request. This is a bug in pd, not a usage error.","exit_code":1,"retry":"never","emitted":0,"details":{"method":"POST","path":"/api/v2/deals"}}
```

`retry` is `never`. `details` carries the method and the resolved path, which is what a bug report
needs. stderr logs the same, at error level.

**Why this is not folded into `internal`, given ADR-0001's rule that a variant must earn its place
by a distinct caller response.** It earns it. On `internal` the caller files a bug and may sensibly
try a different command. On `write_blocked` the correct response is to stop using `pd` entirely and
tell a human, because the safety property is demonstrably broken and no other command is trustworthy
until it is fixed. That is the response class of `blocked`, not of `internal`. The two variants
differ in what the caller must do next, which is the test ADR-0001 sets.

Adding a `code` is explicitly non-breaking under ADR-0001's compatibility rules, and an agent that
has never heard of `write_blocked` still reads `retry: "never"` and stops.

The message says *this is a bug in pd, not a usage error* because the opposite reading is expensive:
an agent that thinks it did something wrong retries with different arguments, and the whole point of
the variant is that nothing the caller types can fix it.

### 5. No write reached Pipedrive when `write_blocked` fires

Layer (b) sits inside the custom `fetch`, which is the choke point *before* the network call. The
refusal happens instead of the request, not after it. This is worth stating in the ADR because it is
the first question a human triaging a `write_blocked` will ask, and the answer must not depend on
reading the implementation.

### 6. `pd auth status` says the token is write-capable, every time it runs

The risk [ADR-0012](0012-authentication-and-credential-resolution.md)'s consequences recorded and
handed to this ticket: a user reads "read-only tool", supplies an administrator's token, and has
given a fully privileged credential to a program whose safety rests on its own correctness. `pd`
cannot detect this — ADR-0012 §6 kept `GET /users/me` out of the generated surface, and no GET reports
what a token may write.

So `pd` says it rather than checks it. ADR-0012 §5's single JSON object gains two fields:

```json
{
  "found": true,
  "tier": "env",
  "fingerprint": "3f2a1c9e8b7d4a60",
  "cache_dir_exists": true,
  "credential_is_write_capable": true,
  "warnings": ["pd cannot restrict this token. It authorises writes against Pipedrive. pd never issues them, but that is pd's code and not Pipedrive's. Use a token belonging to a user with a restricted Pipedrive permission set."]
}
```

`credential_is_write_capable` is a constant `true` whenever a credential is found, and it is a
constant deliberately: it is a statement about the API-token mechanism, not a measurement of this
token. It is present so a harness can branch on the fact without parsing the prose beside it.

The warning is a **field on that object**, not an [ADR-0006](0006-validation-placement-and-rejection.md)
`warning` line, because ADR-0012 §5 makes `pd auth status` an emitter of one JSON object rather than
an NDJSON stream. `--pretty` renders the same text.

**It appears on `pd auth status` and nowhere else.** Emitting it from every data command was
rejected: a warning on every invocation of every command is read once and filtered forever, and it
would put a `warning` line into the record stream of every list command for a condition that never
changes. `AGENTS.md` and the root `--help` page carry the same paragraph, per ADR-0009 §6's first
channel.

### 7. What would have to go wrong: three independent failures, none of them Pipedrive's problem

For a write to reach Pipedrive, **all three** of these must hold at once:

1. **A write operation exists in the codebase** — the generation filter was removed, edited, or
   evaded, or a write was hand-written against the client. Layer (a).
2. **CI did not catch it** — the gate of §2 was disabled, skipped, or merged around. Layer (d).
3. **The runtime guard did not stop it** — the request was routed past the custom `fetch` through
   research 06 §1.5's per-call override, or the guard itself was broken. Layer (b).

No single bug produces a write. The nearest miss is a wrapper bug that constructs a non-GET request
directly, and layer (b) stops it and reports §4's error.

What this design honestly **does not** have:

- **Nothing outside `pd` enforces anything.** Not the credential, not the transport, not Pipedrive.
  All four layers are code in this repository, reviewed by the same people, and a sufficiently
  determined or sufficiently careless change removes all of them together.
- **The account-level mitigations are somebody else's.** A restricted Pipedrive permission set on the
  human the token belongs to, and regenerating the token as revocation. ADR-0012 §2 named both;
  both are account administration and `pd` can only document them, which §6 does.
- **A compiled binary is not evidence.** Research 07's install path ships a binary a user cannot
  inspect. The guarantee travels as a claim about the source, and it is only as good as the CI gate
  that the source passed.

### 8. Local writes are outside the property, and the wording is [ADR-0009](0009-command-surface-and-manifest.md) §6's, unchanged

Read-only is a property of what `pd` does to the **Pipedrive API**. The manifest carries
`"read_only": true` beside `"read_only_scope": "pipedrive_api"`, and that adjacent field is what
stops the claim reading as a loophole when `pd cache clear` deletes local files.

The surface this has to cover shrank to one thing. ADR-0012 §5 removed `pd auth login`, so `pd`
writes no credential at all; the cache of [ADR-0005](0005-cache-design.md) is the only local write
that exists, plus the `blocked` sentinel [ADR-0010](0010-budget-guard.md) §7 put beside it. Both are
`pd`'s own state in `pd`'s own directory, and neither is data any other program owns.

This ADR confirms that wording rather than inventing it, which is what the ticket's own context note
asked for.

## Consequences

- **[ADR-0001](0001-error-model-and-exit-codes.md) grows to twelve variants.** `write_blocked`,
  exit 1, `retry: never`. Its variant table and its exit-1 grab bag both gain a row, and the mapping
  table that ships in the manifest gains the entry automatically. Non-breaking by ADR-0001's own
  compatibility rules.
- **[ADR-0012](0012-authentication-and-credential-resolution.md) §5 gains two fields** on the
  `pd auth status` object: `credential_is_write_capable` and `warnings`. The command still makes zero
  network requests and still writes nothing.
- **[ADR-0009](0009-command-surface-and-manifest.md) §6 is confirmed, not amended.** Its three
  channels and its `read_only_scope` wording are adopted as written.
- **[ADR-0007](0007-the-narrow-v1-users-client.md) is untouched.** §3 applies the same filter and the
  same guard to the v1 client; its single-operation surface is what makes that free.
- **The generator configuration is now load-bearing for a safety property.** `parser.filters.operations.include`
  and `sdk.client: false` are not tuning knobs. The regeneration script's documentation must say so,
  and the CI gate of §2 is what enforces it when the documentation is not read.
- **[Ticket 28](../../.scratch/pd-cli-design/issues/28-grilling-testing-strategy.md) inherits two
  named tests it does not get to skip**: the generated-output assertion of §2 and the `write_blocked`
  unit test of §2. It may decide how they are structured; it may not decide whether they exist.
- **`AGENTS.md` gains** one paragraph stating that `pd` issues GET requests only, that the guarantee
  is `pd`'s own code and not a Pipedrive restriction, that the token supplied is write-capable
  regardless, and that a restricted Pipedrive permission set on the token's user is the only
  account-level mitigation. The same text is the root `--help` page's opening lines.
