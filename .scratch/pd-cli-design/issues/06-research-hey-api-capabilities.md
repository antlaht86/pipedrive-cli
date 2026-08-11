# What `@hey-api/openapi-ts` can generate and how it can be wrapped

Type: research
Status: resolved

## Question

What does the generator give us, and where are the seams for the single client module?

- The zod plugin: what it emits, whether schemas cover responses as well as requests, how faithful they are to the spec, and how a generated schema is overridden where the spec is wrong or too loose.
- The client layer: which client the SDK plugin targets, and what interception points exist — a custom fetch, request and response middleware, a base client instance. This is how every HTTP call is forced through one module that owns rate limiting, retry, concurrency and budget accounting.
- Whether the generated SDK can be configured so no call bypasses that module, and whether generated code can be made to throw or return in a way that composes with `neverthrow`.
- How the generator represents errors and non-2xx responses.
- Whether generation can be restricted to a subset of operations — relevant to keeping a read-only surface, and to whether write operations even exist in the generated output.
- How two specs (v1 and v2) coexist in one project without name collisions.
- The `propertiesRequiredByDefault` transform already used in `openapi-ts.ts` and what it does to nullable or omitted fields in real responses.

Feeds the zod placement, streaming composition and v1 exposure decisions.

## Answer

Findings: [research/06-hey-api-capabilities.md](../research/06-hey-api-capabilities.md), with a recommended generator configuration in its section 7.

**The seam exists and is strong.** Setting `sdk.client: false` removes the default client from the generated SDK entirely, so every generated function must be handed a client explicitly — there is no ambient instance for a call site to reach for. Combined with a custom `fetch` as the choke point inside that client, this satisfies the locked requirement that one module owns every HTTP call. `runtimeConfigPath` supplies configuration that survives regeneration.

**Schemas can be overridden regeneration-safely** via `parser.patch`, a hand-written patch applied to the spec before generation — the right place for the nullability lies a real CRM will expose. The zod plugin's fidelity is only as good as the spec, and the findings argue against wiring zod into the SDK layer itself.

The findings also cover how non-2xx responses are represented and how they compose with `neverthrow`, how generation can be restricted to a read-only surface, how two specs coexist in one project, and what `propertiesRequiredByDefault: true` — already set in this repo's `openapi-ts.ts` — actually does, along with its risk when the real API omits a field the spec marks present.
