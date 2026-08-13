/**
 * The cursor walk — ADR-0004's `AsyncGenerator<Result<Page, PdError>>`.
 *
 * This is the only place in `pd` that knows a cursor exists. It owns
 * validation, deduplication and the bound, and it yields nothing downstream is
 * allowed to re-filter (ADR-0004 §"The generator owns …").
 *
 * ## What is deliberately absent
 *
 * No retry, no backoff, no 429 inference, no Cloudflare stop, no rate limit, no
 * request accounting. All of that lives beneath this loop in `guardedFetch`, and
 * ADR-0004 states that if any of it appears here, locked point 7 has been
 * violated. By the time an `Err` reaches this loop, retrying is already spent
 * and the only correct response is to stop — which is why a page is **atomic**:
 * an `Ok` page or a terminal `Err`, never a partial page.
 *
 * ## No running total
 *
 * The generator carries a countdown against `limit`, never a count of what it
 * has produced. `bound` rides on the final page rather than in the generator's
 * return position, because `for await` discards a return value and because
 * inferring the bound from `emitted === limit` in the writer would report
 * `complete: false` for a set that happened to hold exactly `limit` records
 * (ADR-0004 §"`bound` rides on the page"). `NdjsonWriter.emitted` stays the one
 * cumulative record count in the process.
 */

import { ok, err, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { PdWarning, RecordRejected } from "../warnings.ts";
import { ListEnvelope, nextCursorOf } from "./envelope.ts";
import type { PipedriveClient } from "./client.ts";

/** ADR-0003: the value set of `reason` on a bounded `summary`, today one value. */
export type Bound = "limit";

export type Page<T> = {
  /** Validated, deduplicated and bounded. Nothing downstream re-filters. */
  records: T[];
  /** One per record this page's record schema rejected, before deduplication. */
  warnings: PdWarning[];
  /** Records this page suppressed as already seen earlier in the run. */
  duplicates: number;
  /** Set on the final page only. */
  bound?: Bound;
};

/**
 * Page size is internal and fixed at the endpoint maximum (ADR-0003 §1, spec
 * §9). It is not a flag, and `--limit` is a record count that never reaches it.
 * `/itemSearch` caps at 100 and ticket 15 reads its own ceiling here.
 */
export const LIST_PAGE_SIZE = 500;

/** A cursor page fetch, already gated, retried and counted below this layer. */
export type FetchPage = (
  cursor: string | undefined,
) => ReturnType<PipedriveClient["v2"]>;

export type WalkOptions<T> = {
  /** The `resource` field on a `record_rejected` warning — `"deal"`. */
  resource: string;
  record: z.ZodType<T, unknown>;
  fetchPage: FetchPage;
  /**
   * ADR-0003 §4 / ADR-0017 §9: `id` on a list, `(record_type, id)` on the mixed
   * `pd items search` stream, where a deal and a person may share an id.
   */
  keyOf: (record: T) => string | number;
  /** ADR-0003 §1, counted after rejection and deduplication. Ticket 06 wires it. */
  limit?: number;
};

/**
 * `id` is best-effort (ADR-0006 §6): the record failed validation, so its `id`
 * is untrustworthy by assumption and is recovered by its own parse. The field is
 * **omitted** rather than `null` when that also fails, so a consumer never has
 * to tell "no id" from "id was null".
 */
const IdOnly = z.object({ id: z.int() });

const idOf = (raw: unknown): number | undefined => {
  const parsed = IdOnly.safeParse(raw);
  return parsed.success ? parsed.data.id : undefined;
};

/**
 * One warning per rejected record. The first issue is the reported cause: a
 * record with three bad fields has one reason a caller will act on, and the
 * writer's cause deduplication (ADR-0006 §5) would otherwise report the same
 * record under three keys.
 *
 * `path` is record-relative because each element is parsed on its own, so it can
 * never carry the element's index within its page — which locked point 5 keeps
 * internal, and which would make one cause look like many. A failure of the
 * record as a whole (an element that is not an object) has an empty path and is
 * reported as `""`.
 *
 * Key order here is the key order on the wire; the writer does not reorder.
 */
const rejection = (
  resource: string,
  raw: unknown,
  error: z.ZodError,
): RecordRejected => {
  const issue = error.issues[0];
  const id = idOf(raw);
  return {
    kind: "record_rejected",
    resource,
    ...(id === undefined ? {} : { id }),
    path: (issue?.path ?? []).join("."),
    issue: issue?.code ?? "invalid_type",
    message: issue?.message ?? "The record did not match pd's schema.",
  };
};

const noSurvivors = (resource: string, count: number): PdError =>
  pdError({
    code: "invalid_response",
    message:
      `None of the ${count} ${resource} records on the first page matched pd's schema. ` +
      "The schema does not describe this resource; retrying will not help.",
    details: { resource, rejected: count },
  });

/**
 * Exported for `single.ts`, which reads the by-id envelope: the two shapes
 * differ, but a body `pd` cannot read is the same `invalid_response` with the
 * same first-five issues either way, and one builder keeps it that way.
 */
export const structural = (message: string, error: z.ZodError): PdError =>
  pdError({
    code: "invalid_response",
    message,
    details: {
      issues: error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    },
  });

export async function* walk<T>({
  resource,
  record,
  fetchPage,
  keyOf,
  limit,
}: WalkOptions<T>): AsyncGenerator<Result<Page<T>, PdError>> {
  const seen = new Set<string | number>();
  let cursor: string | undefined;
  let first = true;
  // A countdown, not a total. `undefined` is ADR-0003's default: everything.
  let remaining = limit;

  for (;;) {
    const body = await fetchPage(cursor);
    if (body.isErr()) {
      yield err(body.error);
      return;
    }

    const envelope = ListEnvelope.safeParse(body.value);
    if (!envelope.success) {
      yield err(
        structural(
          "Pipedrive returned a list body pd cannot read. Retrying will not help.",
          envelope.error,
        ),
      );
      return;
    }

    const records: T[] = [];
    const warnings: PdWarning[] = [];
    let rejected = 0;
    let duplicates = 0;

    for (const raw of envelope.data.data) {
      const parsed = record.safeParse(raw);
      if (!parsed.success) {
        rejected += 1;
        warnings.push(rejection(resource, raw, parsed.error));
        continue;
      }
      // ADR-0003 §4: every id seen for the whole run, no cap, no window.
      const key = keyOf(parsed.data);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      records.push(parsed.data);
    }

    // ADR-0006 §4. Zero survivors out of one or more elements on the **first**
    // page means the schema does not describe this resource at all. It fires
    // before any `record` line is written, so the error trailer's `emitted: 0`
    // is true and nothing has to be retracted. No later page escalates, and
    // there is no ratio threshold: under keyset-like cursors old records cluster
    // on the early pages, so a wholly rejected later page is the survivable case.
    if (first && rejected > 0 && rejected === envelope.data.data.length) {
      yield err(noSurvivors(resource, rejected));
      return;
    }
    first = false;

    cursor = nextCursorOf(envelope.data);

    if (remaining === undefined) {
      yield ok({ records, warnings, duplicates });
      if (cursor === undefined) return;
      continue;
    }

    // ADR-0004: the marker may not lie. A limit that fills exactly at a page
    // boundary with a `null` cursor is a complete answer; a limit that fills
    // where the cursor continues is bounded, even if the next page would have
    // been empty. There is no way to know that without fetching it, and
    // reporting a walk complete when it might not be is the worse mistake.
    if (records.length >= remaining) {
      const bounded = records.slice(0, remaining);
      const exactlyAtBoundary =
        records.length === remaining && cursor === undefined;
      yield ok({
        records: bounded,
        warnings,
        duplicates,
        ...(exactlyAtBoundary ? {} : { bound: "limit" as const }),
      });
      return;
    }

    remaining -= records.length;
    yield ok({ records, warnings, duplicates });
    if (cursor === undefined) return;
  }
}
