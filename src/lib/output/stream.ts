/**
 * The two ways a walk becomes output — ADR-0004.
 *
 * `stream` is the consuming loop the ADR writes out verbatim, and it exists
 * **once**: every record-streaming command drives its generator through this
 * function rather than writing its own `for await`, because the loop is where
 * the exactly-one-trailer invariant is honoured and a hand-rolled copy is where
 * it is forgotten.
 *
 * `collect` is the specified non-streaming path for a command needing whole-set
 * post-processing — sorting, aggregation, "top 10 by value". It reuses the same
 * writer, so the output contract, the trailer and the counters are identical and
 * the format cannot diverge between the two paths. **No command uses it yet**;
 * any that does is marked `delivery: "collects"` in the manifest, because its
 * time to first byte is its total wall time.
 */

import type { Result } from "neverthrow";

import type { PdError } from "../errors.ts";
import type { Bound, Page } from "../pipedrive/walk.ts";
import type { NdjsonWriter } from "./ndjson-writer.ts";

export type Pages = AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>>;

/** Returns the process exit code. The trailer is written before it returns. */
export const stream = async (
  pages: Pages,
  writer: NdjsonWriter,
): Promise<number> => {
  for await (const page of pages) {
    if (page.isErr()) return writer.error(page.error);
    writer.page(page.value);
    if (page.value.bound !== undefined) return writer.finish(page.value.bound);
  }
  return writer.finish(null);
};

/**
 * Drains the walk into memory and hands the whole set to `transform` before a
 * single `record` line is written.
 *
 * **On failure the collected path emits `emitted: 0` and writes none of the
 * records it holds.** Half of a sorted list is not a partial answer, it is a
 * wrong one: the records are in the wrong order and nothing in the output would
 * say so. This diverges from the streaming path's "already written stays
 * written" deliberately, and costs the caller nothing it could have used,
 * because no `record` line has been written yet.
 */
export const collect = async (
  pages: Pages,
  writer: NdjsonWriter,
  transform: (records: Record<string, unknown>[]) => Record<string, unknown>[] = (
    records,
  ) => records,
): Promise<number> => {
  const held: Record<string, unknown>[] = [];
  let bound: Bound | null = null;

  for await (const page of pages) {
    if (page.isErr()) return writer.error(page.error);
    held.push(...writer.hold(page.value));
    if (page.value.bound !== undefined) {
      bound = page.value.bound;
      break;
    }
  }

  writer.records(transform(held));
  return writer.finish(bound);
};
