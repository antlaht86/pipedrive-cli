import type { UserConfig } from "@hey-api/openapi-ts";

/**
 * Two generation jobs, two output directories — ADR-0007 §1. The `@hey-api`
 * merge form (`input: [a, b]`) is deliberately not used: both specs define
 * `getUsers`, and separate directories keep the namespaces apart.
 *
 * ## This file is load-bearing for a safety property
 *
 * ADR-0013 §1 makes `parser.filters.operations.include` read-only layer (a) and
 * `sdk.client: false` the compile-time single choke point. Neither is a tuning
 * knob:
 *
 * - `include: ['/^GET /']` means a write operation is never generated, so no
 *   call site can reach one. `test/generated-read-only.test.ts` fails the build
 *   if a regeneration ever reintroduces one.
 * - `sdk.client: false` removes the ambient client from the generated SDK, so a
 *   generated function cannot be called without being handed the client that
 *   the wrapper module constructed.
 *
 * `sdk.validator: false` is a validation placement decision, ADR-0006 §1: the
 * generated `z*Response` schemas are run explicitly with `safeParse` inside the
 * wrapper, so a parse failure becomes a typed `PdError` instead of sharing one
 * untyped `error` field with transport and HTTP failures.
 *
 * Generated output is committed and never hand-edited. Spec corrections are
 * `parser.patch` entries against the input spec — see `patchV2Spec` below.
 *
 * Regenerate with `bun run openapi-ts`. Both dependency versions are pinned
 * exactly, because the generator's config surface churns between minors.
 */

const V2_SPEC = "https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml";
const V1_SPEC = "https://developers.pipedrive.com/docs/api/v1/openapi.yaml";

/**
 * Fields the v2 spec types as non-nullable that the real API returns as `null`.
 *
 * `next_cursor` is load-bearing: it is `null` on the last page of every list, so
 * a complete walk cannot work at all without this patch.
 *
 * Pipedrive's spec is OpenAPI 3.0, where nullability is `nullable: true`. The
 * 3.1 spelling (appending `"null"` to `type`) silently degrades the schema to
 * `z.unknown().nullable()` — the base type is lost.
 */
const NULLABLE_IN_PRACTICE = new Set(["next_cursor", "person_id", "org_id"]);

/**
 * One node of the OpenAPI document. The patches below walk an untyped tree, so
 * `SpecNode` and `nodeAt` are how they narrow it once instead of at every step.
 */
type SpecNode = Record<string, unknown>;

const asNode = (value: unknown): SpecNode | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SpecNode)
    : undefined;

/** Follows a key path, giving up at the first step that is not an object. */
const nodeAt = (start: unknown, ...keys: string[]): SpecNode | undefined => {
  let current = asNode(start);
  for (const key of keys) {
    if (current === undefined) return undefined;
    current = asNode(current[key]);
  }
  return current;
};

const relaxNullability = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(relaxNullability);
    return;
  }
  const node = asNode(value);
  if (node === undefined) return;

  const properties = node.type === "object" ? asNode(node.properties) : undefined;
  for (const [key, property] of Object.entries(properties ?? {})) {
    const target = NULLABLE_IN_PRACTICE.has(key) ? asNode(property) : undefined;
    if (target !== undefined) target.nullable = true;
  }

  for (const child of Object.values(node)) relaxNullability(child);
};

/**
 * Collapses a record node's `allOf` chain into one `type: object`.
 *
 * Pipedrive composes some records out of `allOf` members — a product is
 * `BaseProduct` (itself a nested `allOf` of three objects) intersected with
 * `PricesArray`. The hoist below cannot take such a node as it stands, so
 * `zGetProductsItem` did not exist at all and `pd products list` had no record
 * schema to validate against.
 *
 * The merge is into one object rather than a preserved intersection on the
 * reason ADR-0006 §2 already recorded: a `ZodIntersection` supports neither
 * `.pick()` nor `.omit()`, so a record schema that is one would be unrelaxable
 * after the fact and unusable by ADR-0016's projection later.
 *
 * Only the record node's own chain is flattened. A property whose *value* is an
 * `allOf` — `visible_to` on a product — is left alone; the generator already
 * handles that shape.
 *
 * A member that redefines a property its sibling already defined throws rather
 * than letting the last one win, on the same reasoning as the collision guard
 * below: a silent merge of two disagreeing shapes is the failure nobody sees.
 */
const flattenAllOf = (node: SpecNode): SpecNode | undefined => {
  if (!Array.isArray(node.allOf)) return node.type === "object" ? node : undefined;

  const properties: SpecNode = {};
  const required: string[] = [];

  for (const raw of node.allOf) {
    const member = asNode(raw);
    if (member === undefined) return undefined;
    const flattened = flattenAllOf(member);
    if (flattened === undefined) return undefined;

    for (const [key, value] of Object.entries(asNode(flattened.properties) ?? {})) {
      const existing = properties[key];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new Error(
          `Two allOf members of a hoisted record define '${key}' with different shapes. ` +
            "Resolve the disagreement in a patch before regenerating.",
        );
      }
      properties[key] = value;
    }
    if (Array.isArray(flattened.required)) required.push(...(flattened.required as string[]));
  }

  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required: [...new Set(required)] }),
  };
};

/**
 * Hoists the inline record schema of every GET response out of `paths` and into
 * `components/schemas`, leaving a `$ref` behind.
 *
 * ADR-0006 §2 splits validation in two: the envelope is validated strictly and a
 * failure ends the walk, while each element of `data` is validated on its own so
 * one bad record from 2015 becomes a `warning` rather than rejecting its whole
 * page. That needs the record schema as a schema of its own. Pipedrive declares
 * its v2 response bodies inline under `paths`, so the zod plugin emits one
 * `zGetDealsResponse` per operation and no reusable record schema at all.
 *
 * The hoist is done here, in the whole-spec `patch.input` form, because the
 * per-path forms cannot do it: `patch.responses` is keyed by component name and
 * these responses have none, and a `patch.operations` callback is handed the
 * operation node, which has no way to reach `components`.
 *
 * `GetDealsResponse` yields `GetDealsItem`, hence `zGetDealsItem`. Pipedrive
 * reuses a response title across operations, which is harmless while the record
 * shape behind it is the same one — and a silent cross-wiring if it ever is
 * not, so the collision throws rather than letting the last path win.
 */
const hoistResponseRecords = (document: SpecNode): void => {
  const paths = asNode(document.paths);
  if (paths === undefined) return;

  const components = (document.components ??= {}) as SpecNode;
  const schemas = (components.schemas ??= {}) as SpecNode;

  for (const pathItem of Object.values(paths)) {
    const responseSchema = nodeAt(
      pathItem,
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
    );
    if (responseSchema === undefined) continue;

    const title = responseSchema.title;
    if (typeof title !== "string") continue;
    const name = `${title.replace(/Response$/, "")}Item`;

    // A response schema is either a plain object or an `allOf` of them.
    const members = Array.isArray(responseSchema.allOf) ? responseSchema.allOf : [responseSchema];
    for (const member of members) {
      const data = nodeAt(member, "properties", "data");
      if (data === undefined) continue;

      // A list response carries `data` as an array of records, a single-record
      // response carries the record itself. Both are hoisted, so `get` and
      // `list` share one record schema per resource family.
      const isList = data.type === "array";
      const inline = asNode(isList ? data.items : data);
      if (inline === undefined || "$ref" in inline) continue;
      const record = flattenAllOf(inline);
      if (record === undefined) continue;

      const existing = schemas[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          `Two GET operations claim the response title behind '${name}' with different record ` +
            `shapes. Give the hoisted schema a name that includes the operation before regenerating.`,
        );
      }
      schemas[name] = record;

      const reference = { $ref: `#/components/schemas/${name}` };
      if (isList) data.items = reference;
      else nodeAt(member, "properties")!.data = reference;
    }
  }
};

const patchV2Spec = (spec: unknown): void => {
  const document = asNode(spec);
  if (document === undefined) return;
  // Hoist first, so the nullability relaxation reaches the record schemas in
  // their new home under `components` rather than in `paths`.
  hoistResponseRecords(document);
  relaxNullability(document.paths);
  relaxNullability(document.components);
};

const plugins = [
  "@hey-api/client-fetch",
  { name: "@hey-api/sdk", client: false, validator: false },
  { name: "zod", compatibilityVersion: 4, requests: true, responses: true },
] as const satisfies UserConfig["plugins"];

const config: UserConfig[] = [
  {
    input: V2_SPEC,
    output: "src/lib/pipedrive/v2/generated",
    parser: {
      patch: { input: patchV2Spec },
      transforms: { propertiesRequiredByDefault: true },
      // Read-only layer (a), ADR-0013 §1. Do not widen.
      filters: { operations: { include: ["/^GET /"] } },
    },
    plugins,
  },
  {
    input: V1_SPEC,
    output: "src/lib/pipedrive/v1/generated",
    parser: {
      // No patch: ADR-0007 §3 gives `pd` its own user record schema, so nothing
      // downstream trusts the v1 spec's nullability.
      transforms: { propertiesRequiredByDefault: true },
      // The anchored forms are the whole v1 footprint — the collection endpoint
      // and the current-user endpoint, and nothing else (ADR-0007 §1, amended by
      // ADR-0033 §7). `/^GET \/users/` unanchored pulls in six more operations,
      // and generated code that exists is code someone can call. The anchors are
      // what keeps them out.
      filters: {
        operations: { include: ["/^GET \\/users$/", "/^GET \\/users\\/me$/"] },
      },
    },
    plugins,
  },
];

export default config;
