/**
 * Fixtures for the four cached resources — ticket 08.
 *
 * Every key the resource's record schema declares is present, for the reason
 * `records.ts` gives: `propertiesRequiredByDefault: true` flips presence for the
 * whole v2 spec, so a fixture missing one field is a rejected record and a
 * different test than the one that omitted it meant to write.
 *
 * The `users` fixture is the exception, and deliberately: ADR-0007 §3 has `pd`
 * own that record schema, with `id` and `name` required and everything else
 * optional, so the fixture is what v1 actually returns rather than what the
 * generated schema claims.
 */

import type { Fixture } from "./replay.ts";
import type { Overrides } from "./records.ts";

export const user = (id: number, overrides: Overrides = {}): Record<string, unknown> => ({
  id,
  name: `Aino Virtanen ${id}`,
  default_currency: "EUR",
  locale: "fi_FI",
  lang: 1,
  email: `aino.${id}@example.invalid`,
  phone: null,
  activated: true,
  last_login: "2026-08-12 08:00:00",
  created: "2024-01-09 10:11:12",
  modified: null,
  has_created_company: false,
  access: [{ app: "global", admin: true, permission_set_id: "set-1" }],
  active_flag: true,
  timezone_name: "Europe/Helsinki",
  timezone_offset: "+03:00",
  role_id: 1,
  icon_url: null,
  is_you: id === 11,
  is_deleted: false,
  ...overrides,
});

export const pipeline = (
  id: number,
  overrides: Overrides = {},
): Record<string, unknown> => ({
  id,
  name: `Sales ${id}`,
  order_nr: id,
  is_deleted: false,
  is_deal_probability_enabled: true,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  ...overrides,
});

export const stage = (id: number, overrides: Overrides = {}): Record<string, unknown> => ({
  id,
  order_nr: id,
  name: `Qualified ${id}`,
  is_deleted: false,
  deal_probability: 40,
  pipeline_id: 1,
  is_deal_rot_enabled: false,
  days_to_rotten: null,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  ...overrides,
});

/** A custom field: `field_code` is the 40-hex hash an agent needs `--resolve` for. */
export const field = (
  code: string,
  overrides: Overrides = {},
): Record<string, unknown> => ({
  field_name: `Renewal quarter ${code.slice(0, 4)}`,
  field_code: code,
  field_type: "enum",
  options: [
    {
      id: 1,
      label: "Q1",
      color: null,
      update_time: null,
      add_time: null,
    },
  ],
  subfields: null,
  is_custom_field: true,
  is_optional_response_field: false,
  ...overrides,
});

/** The one v1 path `pd` calls, and it takes no query at all. */
export const usersFixture = (data: unknown[]): Fixture => ({
  path: "/v1/users",
  body: { success: true, data },
});

const listQuery = (cursor?: string): Record<string, string | number> =>
  cursor === undefined ? { limit: 500 } : { cursor, limit: 500 };

export const cachedPage = (
  path: string,
  data: unknown[],
  nextCursor: string | null = null,
  cursor?: string,
): Fixture => ({
  path: `/api/v2/${path}`,
  query: listQuery(cursor),
  body: { success: true, data, additional_data: { next_cursor: nextCursor } },
});
