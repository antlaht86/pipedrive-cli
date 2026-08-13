/**
 * The list envelope, and the structural half of ADR-0006 §2's two-stage split.
 *
 * ADR-0006 §2 requires the envelope and the record to fail **differently**: an
 * envelope failure is structural and ends the walk as `invalid_response`, while
 * an element of `data` failing the record schema is one `warning` and
 * `skipped += 1`. The generated `zGetDealsResponse` cannot deliver that. It is
 * `z.object({success}).and(z.object({data: z.array(zGetDealsItem), …}))`, so one
 * bad record from 2015 rejects all 500 records on its page — and being a
 * `ZodIntersection` it supports neither `.pick()` nor `.omit()`, so it cannot be
 * relaxed after the fact either (ADR-0006 §9).
 *
 * This is therefore the hand-written envelope ADR-0006 §2 named as the fallback:
 * three fields, `data` as an array of `unknown`, and the record schema applied
 * per element by the walk. It is written once and shared by every list
 * endpoint, because the v2 list envelope is the same shape on all of them.
 *
 * ## `next_cursor`
 *
 * Absent `additional_data` and an absent, `null` or empty `next_cursor` all mean
 * *this was the last page*. A `next_cursor` **present with a wrong type** is
 * structural, which is the row ADR-0006 §2 spells out — and the reason the field
 * is `.nullable().optional()` rather than `z.unknown()`.
 *
 * The generation-time `nullable: true` patch on `next_cursor` (see
 * `openapi-ts.config.ts`) is what makes the *record* side of a last page work.
 * This schema does not depend on it, deliberately: the envelope is the one thing
 * a walk cannot survive being wrong about, so it does not inherit a spec `pd`
 * has already caught lying.
 */

import { z } from "zod";

/**
 * `success` is validated because ADR-0006 §2 names it. It is not read: a `false`
 * `success` on a 200 has never been observed, and inventing a variant for it
 * would be guessing at a shape rather than describing one.
 */
export const ListEnvelope = z.object({
  success: z.boolean(),
  data: z.array(z.unknown()),
  additional_data: z
    .object({ next_cursor: z.string().nullable().optional() })
    .optional(),
});

export type ListEnvelope = z.infer<typeof ListEnvelope>;

/** `undefined` on the last page, whichever of the four ways it says so. */
export const nextCursorOf = (envelope: ListEnvelope): string | undefined => {
  const cursor = envelope.additional_data?.next_cursor;
  return cursor === null || cursor === undefined || cursor === ""
    ? undefined
    : cursor;
};
