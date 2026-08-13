/**
 * The bound half of the walk.
 *
 * `--limit` is ticket 06's flag and its acceptance tests live there. The
 * *mechanics* are ADR-0004's and are built here, so the marker-may-not-lie table
 * is asserted here too rather than shipping unexercised until the flag arrives.
 */

import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import { z } from "zod";

import { walk } from "./walk.ts";
import type { Page } from "./walk.ts";

const Record_ = z.object({ id: z.int() });

const pagesOf = (...pages: { data: unknown[]; next: string | null }[]) => {
  let index = 0;
  return () => {
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return okAsync<unknown, never>({
      success: true,
      data: page?.data ?? [],
      additional_data: { next_cursor: page?.next ?? null },
    });
  };
};

const record = (id: number) => ({ id });

const drain = async (
  limit: number | undefined,
  ...pages: { data: unknown[]; next: string | null }[]
): Promise<Page<{ id: number }>[]> => {
  const out: Page<{ id: number }>[] = [];
  for await (const page of walk<{ id: number }>({
    resource: "thing",
    record: Record_,
    keyOf: (value) => value.id,
    fetchPage: pagesOf(...pages),
    ...(limit === undefined ? {} : { limit }),
  })) {
    if (page.isErr()) throw new Error(page.error.message);
    out.push(page.value);
  }
  return out;
};

describe("the bound may not lie", () => {
  test("a limit that cuts a page short is bounded", async () => {
    const pages = await drain(2, { data: [record(1), record(2), record(3)], next: "c2" });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.records.map((r) => r.id)).toEqual([1, 2]);
    expect(pages[0]?.bound).toBe("limit");
  });

  test("a limit filling exactly at a page boundary with a null cursor is complete", async () => {
    const pages = await drain(2, { data: [record(1), record(2)], next: null });

    expect(pages[0]?.bound).toBeUndefined();
  });

  test("a limit filling at a boundary where the cursor continues is bounded", async () => {
    // Deliberately conservative: there is no way to know the next page would
    // have been empty without fetching it, and claiming completeness wrongly is
    // the worse mistake.
    const pages = await drain(2, { data: [record(1), record(2)], next: "c2" });

    expect(pages[0]?.bound).toBe("limit");
  });

  test("a limit spanning pages stops on the page that fills it", async () => {
    const pages = await drain(
      3,
      { data: [record(1), record(2)], next: "c2" },
      { data: [record(3), record(4)], next: "c3" },
    );

    expect(pages).toHaveLength(2);
    expect(pages[1]?.records.map((r) => r.id)).toEqual([3]);
    expect(pages[1]?.bound).toBe("limit");
  });

  test("the limit counts after rejection and deduplication", async () => {
    const pages = await drain(
      2,
      { data: [record(1), { id: "bad" }, record(1), record(2), record(3)], next: "c2" },
    );

    expect(pages[0]?.records.map((r) => r.id)).toEqual([1, 2]);
    expect(pages[0]?.warnings).toHaveLength(1);
    expect(pages[0]?.duplicates).toBe(1);
    expect(pages[0]?.bound).toBe("limit");
  });

  test("an unbounded walk runs to the null cursor", async () => {
    const pages = await drain(
      undefined,
      { data: [record(1)], next: "c2" },
      { data: [record(2)], next: null },
    );

    expect(pages).toHaveLength(2);
    expect(pages.every((page) => page.bound === undefined)).toBe(true);
  });
});
