/**
 * A v2 deal as the API actually returns one, and the list envelope around it.
 *
 * Every key the generated `zGetDealsItem` declares is present. That is no longer
 * required of a fixture — ADR-0029 §3 stopped the generated schema gating a
 * record, so a deal missing a field now emits — but it is kept, because a
 * complete deal is what `--fields` and the projection tests want to select from.
 * The one thing it must not be read as is a claim about the API: a real open
 * deal carries no `won_time`, and the deals-list suite has its own fixtures that
 * omit the three fields ticket 21 found.
 *
 * ADR-0019 §10 keeps real CRM data out of the fixture tree; these are invented
 * and hold no credential-shaped string.
 */

export type DealOverrides = Record<string, unknown>;

export const deal = (id: number, overrides: DealOverrides = {}): Record<string, unknown> => ({
  id,
  title: `Acme Oy — annual licence ${2020 + (id % 6)}`,
  owner_id: 11,
  person_id: 5000 + id,
  org_id: 900 + (id % 40),
  pipeline_id: 1,
  stage_id: 3 + (id % 4),
  value: 12000 + id * 37,
  currency: "EUR",
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  stage_change_time: "2026-01-09T07:45:00Z",
  is_deleted: false,
  is_archived: false,
  status: "open",
  probability: null,
  lost_reason: null,
  visible_to: 3,
  close_time: null,
  won_time: "2026-03-01T10:00:00Z",
  lost_time: "2026-03-01T10:00:00Z",
  expected_close_date: "2026-06-30",
  label_ids: [],
  origin: "ManuallyCreated",
  origin_id: null,
  channel: null,
  channel_id: null,
  source_lead_id: null,
  arr: null,
  mrr: null,
  acv: null,
  custom_fields: {},
  ...overrides,
});

export const dealsPage = (
  data: unknown[],
  nextCursor: string | null = null,
): Record<string, unknown> => ({
  success: true,
  data,
  additional_data: { next_cursor: nextCursor },
});

/** The query `walkDeals` sends: the fixed page size, plus a cursor after page one. */
export const dealsQuery = (cursor?: string): Record<string, string | number> =>
  cursor === undefined ? { limit: 500 } : { cursor, limit: 500 };

export const DEALS_PATH = "/api/v2/deals";
