/**
 * The `deal` resource: `pd`'s record schema and the walk that produces it.
 *
 * The schema is the generated `zGetDealsItem`, which exists because
 * `openapi-ts.config.ts` hoists each list response's inline record out of
 * `paths` into `components/schemas` (ADR-0006 §2). Nothing is hand-written on
 * top of it and nothing relaxes it here: ADR-0006 §9 requires every correction
 * to be a `parser.patch` against the input spec, so that types and schemas move
 * together and no generated file is edited.
 *
 * Unknown keys are stripped, because `z.object` strips them in zod v4 and
 * ADR-0006 §3 accepts that default deliberately — a `record` line's shape is a
 * function of `pd`'s version, not Pipedrive's release schedule. The one
 * protected exception is already in the generated schema:
 * `custom_fields: z.record(z.string(), z.unknown())`, which no patch may close.
 *
 * Ticket 07's eight remaining resources are this file with two names changed:
 * the generated list operation and the `record_type`. Nothing about the walk,
 * the validation split or the writer is per-resource.
 */

import type { z } from "zod";
import type { Result } from "neverthrow";

import type { PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import { LIST_PAGE_SIZE, walk } from "./walk.ts";
import type { Page } from "./walk.ts";
import { getDeals } from "./v2/generated/sdk.gen.ts";
import { zGetDealsItem } from "./v2/generated/zod.gen.ts";

/** ADR-0009: singular, and the only singular/plural mapping on the surface. */
export const DEAL_RECORD_TYPE = "deal";

export const Deal = zGetDealsItem;
export type Deal = z.infer<typeof Deal>;

export type DealsListOptions = {
  /** ADR-0003 §1. Ticket 06 owns the flag; the mechanics are in `walk.ts`. */
  limit?: number;
};

/**
 * The walk is generic over the record type; the return type widens `Deal` to the
 * open record the writer serialises. Widening at the boundary rather than
 * threading the concrete type through the walk and the writer is what keeps one
 * walk for all nine resources — and it costs no cast.
 */
export const walkDeals = (
  client: PipedriveClient,
  { limit }: DealsListOptions = {},
): AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>> =>
  walk<Deal>({
    resource: DEAL_RECORD_TYPE,
    record: Deal,
    keyOf: (record) => record.id,
    ...(limit === undefined ? {} : { limit }),
    fetchPage: (cursor) =>
      client.v2(getDeals, {
        query: {
          limit: LIST_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
  });
