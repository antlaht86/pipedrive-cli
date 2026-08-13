/**
 * The resource table's one regeneration hazard.
 *
 * Pipedrive titles a by-id response differently from the list response —
 * `UpsertDealResponse` against `GetDealsResponse` — so the hoist in
 * `openapi-ts.config.ts` produces two record schemas per resource.
 * `resources.ts` uses the list one for both verbs, which is only honest while
 * the two agree. A regeneration is exactly when that could stop being true, and
 * it would be invisible: `pd deals get` would keep working while quietly
 * validating against the wrong shape.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import * as generated from "./v2/generated/zod.gen.ts";

describe("the by-id and list record schemas are the same shape", () => {
  const asJson = (schema: z.ZodType): string =>
    JSON.stringify(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));

  const PAIRS: [string, z.ZodType, z.ZodType][] = [
    ["deal", generated.zGetDealsItem, generated.zUpsertDealItem],
    ["person", generated.zGetPersonsItem, generated.zUpsertPersonItem],
    [
      "organization",
      generated.zGetOrganizationsItem,
      generated.zUpsertOrganizationItem,
    ],
    ["activity", generated.zGetActivitiesItem, generated.zUpsertActivityItem],
    ["product", generated.zGetProductsItem, generated.zGetProductItem],
  ];

  for (const [name, list, byId] of PAIRS) {
    test(`${name}`, () => {
      expect(asJson(byId)).toBe(asJson(list));
    });
  }
});
