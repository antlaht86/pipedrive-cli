/**
 * A record of each live resource, as the v2 API actually returns one.
 *
 * Every key the resource's generated item schema declares is present, because
 * `propertiesRequiredByDefault: true` (see `openapi-ts.config.ts`) flips
 * presence for the whole v2 spec — a fixture missing one field is a rejected
 * record, which is a different test than the one that omitted it meant to
 * write.
 *
 * `deal` lives in `deals.ts` beside ticket 05's fixtures; the four here join
 * it, and the tables at the bottom are what lets one test body run against all
 * five.
 *
 * ADR-0019 §10 keeps real CRM data out of the fixture tree; these are invented
 * and hold no credential-shaped string.
 */

import { deal } from "./deals.ts";
import type { Fixture } from "./replay.ts";

export type Overrides = Record<string, unknown>;

export type Factory = (id: number, overrides?: Overrides) => Record<string, unknown>;

/** The ten-key address block persons, organizations and activities share. */
const place = (locality: string): Record<string, unknown> => ({
  value: `Mannerheimintie 12, ${locality}`,
  country: "Finland",
  admin_area_level_1: "Uusimaa",
  admin_area_level_2: "Helsinki sub-region",
  locality,
  sublocality: "Kamppi",
  route: "Mannerheimintie",
  street_number: "12",
  subpremise: "A 4",
  postal_code: "00100",
});

export const person: Factory = (id, overrides = {}) => ({
  id,
  name: `Aino Virtanen ${id}`,
  first_name: "Aino",
  last_name: `Virtanen ${id}`,
  owner_id: 11,
  org_id: 900 + (id % 40),
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  emails: [{ value: `aino.${id}@example.invalid`, primary: true, label: "work" }],
  phones: [{ value: "+358 40 000 0000", primary: true, label: "mobile" }],
  is_deleted: false,
  visible_to: 3,
  label_ids: [],
  picture_id: 77,
  postal_address: place("Helsinki"),
  notes: "",
  im: [{ value: `aino.${id}`, primary: true, label: "slack" }],
  birthday: "1988-04-17",
  job_title: "Procurement lead",
  custom_fields: {},
  ...overrides,
});

export const organization: Factory = (id, overrides = {}) => ({
  id,
  name: `Acme Oy ${id}`,
  owner_id: 11,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  is_deleted: false,
  visible_to: 3,
  address: place("Espoo"),
  label_ids: [],
  website: "https://acme.example.invalid",
  linkedin: null,
  industry: null,
  annual_revenue: 4200000,
  employee_count: 120,
  custom_fields: {},
  ...overrides,
});

export const activity: Factory = (id, overrides = {}) => ({
  id,
  subject: `Call Acme about renewal ${id}`,
  type: "call",
  owner_id: 11,
  creator_user_id: 11,
  is_deleted: false,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  deal_id: 3000 + id,
  lead_id: "adf5f1a2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  person_id: 5000 + id,
  org_id: 900 + (id % 40),
  project_id: 12,
  // ADR-0020 §4: account-local wall clock, two fields, never joined.
  due_date: "2026-06-30",
  due_time: "15:00:00",
  duration: "00:30:00",
  busy: true,
  done: false,
  marked_as_done_time: "2026-03-01T10:00:00Z",
  location: place("Tampere"),
  participants: [{ person_id: 5000 + id, primary: true }],
  attendees: [
    {
      email: `aino.${id}@example.invalid`,
      name: "Aino Virtanen",
      status: "accepted",
      is_organizer: true,
      person_id: 5000 + id,
      user_id: 11,
    },
  ],
  conference_meeting_client: "meet",
  conference_meeting_url: "https://meet.example.invalid/abc-defg-hij",
  conference_meeting_id: "abc-defg-hij",
  public_description: "",
  priority: 2,
  note: "",
  ...overrides,
});

export const product: Factory = (id, overrides = {}) => ({
  id,
  name: `Annual licence ${id}`,
  code: `LIC-${id}`,
  unit: "seat",
  tax: 25.5,
  is_deleted: false,
  is_linkable: true,
  visible_to: 3,
  owner_id: 11,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  description: "One seat, one year.",
  category: null,
  custom_fields: {},
  billing_frequency: "annually",
  billing_frequency_cycles: null,
  // ADR-0020 §7: the nested block, money as JSON numbers with a currency
  // sibling inside each price object.
  prices: [
    {
      product_id: id,
      price: 1200,
      currency: "EUR",
      cost: 300,
      direct_cost: null,
      notes: "",
    },
  ],
  ...overrides,
});

export type LiveResource = {
  /** The plural noun on the command line. */
  name: string;
  /** The `record_type` on every emitted line. */
  recordType: string;
  record: Factory;
  /** The path `list` walks. */
  path: string;
};

export const LIVE: readonly LiveResource[] = [
  { name: "deals", recordType: "deal", record: deal, path: "/api/v2/deals" },
  { name: "persons", recordType: "person", record: person, path: "/api/v2/persons" },
  {
    name: "organizations",
    recordType: "organization",
    record: organization,
    path: "/api/v2/organizations",
  },
  {
    name: "activities",
    recordType: "activity",
    record: activity,
    path: "/api/v2/activities",
  },
  { name: "products", recordType: "product", record: product, path: "/api/v2/products" },
];

/** The query every v2 list walk sends: the fixed page size, plus a cursor. */
export const listQuery = (cursor?: string): Record<string, string | number> =>
  cursor === undefined ? { limit: 500 } : { cursor, limit: 500 };

export const listPage = (
  resource: LiveResource,
  data: unknown[],
  nextCursor: string | null = null,
  cursor?: string,
): Fixture => ({
  path: resource.path,
  query: listQuery(cursor),
  body: { success: true, data, additional_data: { next_cursor: nextCursor } },
});

/** `GET /api/v2/<resource>/<id>` — the by-id body carries the record itself. */
export const getRecord = (
  resource: LiveResource,
  id: number,
  overrides: Overrides = {},
): Fixture => ({
  path: `${resource.path}/${id}`,
  body: { success: true, data: resource.record(id, overrides) },
});
