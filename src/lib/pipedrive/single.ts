/**
 * The by-id fetch — what `pd <resource> get <id>` walks instead of a cursor.
 *
 * It is a generator of exactly one page so that `get` and `list` share
 * `stream()`, the writer, the trailer and the counters (ADR-0004). A second
 * consuming loop is a second place the exactly-one-trailer invariant can be
 * forgotten, and there is nothing about one record that needs one.
 *
 * ## The envelope is a different shape, and fails the same way
 *
 * A list body carries `data` as an array; a by-id body carries the record
 * itself. Both are validated structurally before the record schema runs, which
 * is ADR-0006 §2's two-stage split unchanged — the envelope ends the run as
 * `invalid_response`, the record is judged on its own.
 *
 * ## A rejected single record is an error, not a warning
 *
 * On a list, one bad record out of five hundred is a `warning` and the walk
 * continues; the caller still gets the answer it asked for, minus one row. On
 * `get`, the rejected record **is** the answer. Reporting `emitted: 0` with
 * `complete: true` would say the record does not exist, which is what
 * `not_found` means and is not what happened. ADR-0006 §4's reading is the one
 * that fits: `pd` cannot read this record at all, so the run ends as
 * `invalid_response`, exit 1.
 *
 * ADR-0029 §5 narrowed what can get here. On the five live resources a record is
 * rejected only for carrying no readable `id`, so this path now answers "the
 * body under `data` is not an identifiable record" and nothing finer.
 *
 * `not_found` is left to the 404 the wrapper seam already maps (ADR-0024), so
 * "no such record" and "a record pd cannot read" never share a code.
 */

import { ok, err, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import { structural, type Page } from "./walk.ts";

/**
 * `data` is `unknown` for the same reason the list envelope's array elements
 * are: the record gate is applied separately, one stage later.
 */
export const RecordEnvelope = z.object({
  success: z.boolean(),
  data: z.unknown(),
});

export type SingleOptions<T> = {
  /** The `resource` field on the error's details — `"deal"`. */
  resource: string;
  record: z.ZodType<T, unknown>;
  id: number;
  fetch: () => ReturnType<PipedriveClient["v2"]>;
};

/**
 * Exported for the cached resources, whose `get` filters a list rather than
 * fetching one record but reaches the identical situation: the record that
 * **is** the answer does not match `pd`'s schema. `id` is widened to a string
 * because ADR-0009 §3 makes `fields` the one resource whose id is not an
 * integer.
 */
export const rejectedRecord = (
  resource: string,
  id: number | string,
  error: z.ZodError,
): PdError => {
  const issue = error.issues[0];
  return pdError({
    code: "invalid_response",
    message:
      `The ${resource} Pipedrive returned for id ${id} is not one pd can read. ` +
      "Retrying will not help.",
    details: {
      resource,
      id,
      path: (issue?.path ?? []).join("."),
      issue: issue?.code ?? "invalid_type",
    },
  });
};

export async function* single<T>({
  resource,
  record,
  id,
  fetch,
}: SingleOptions<T>): AsyncGenerator<Result<Page<T>, PdError>> {
  const body = await fetch();
  if (body.isErr()) {
    yield err(body.error);
    return;
  }

  const envelope = RecordEnvelope.safeParse(body.value);
  if (!envelope.success) {
    yield err(
      structural(
        "Pipedrive returned a record body pd cannot read. Retrying will not help.",
        envelope.error,
      ),
    );
    return;
  }

  const parsed = record.safeParse(envelope.data.data);
  if (!parsed.success) {
    yield err(rejectedRecord(resource, id, parsed.error));
    return;
  }

  // No `bound`: one record is never a bounded answer, so the trailer reads
  // `complete: true`.
  yield ok({ records: [parsed.data], warnings: [], duplicates: 0 });
}
