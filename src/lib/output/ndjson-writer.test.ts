/**
 * `NdjsonWriter` and the two consuming loops.
 *
 * The cases here are the ones the replay suite cannot reach cheaply: a
 * pathological schema producing more than fifty distinct rejection causes, a
 * second trailer, and the collected path — which no command uses yet and which
 * therefore has no end-to-end run to be tested through.
 */

import { describe, expect, test } from "bun:test";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";

import { pdError, type PdError } from "../errors.ts";
import { isPdFailure } from "../pipedrive/failure.ts";
import type { Page } from "../pipedrive/walk.ts";
import { NdjsonWriter } from "./ndjson-writer.ts";
import { collect, stream } from "./stream.ts";
import { capture, type Line } from "../../../test/support/ndjson.ts";

const writerOf = (): {
  writer: NdjsonWriter;
  lines: () => Line[];
  stderr: string[];
} => {
  const out = capture();
  const writer = new NdjsonWriter({
    recordType: "deal",
    requests: () => 3,
    sink: out.sink,
    stderr: out.stderr,
  });
  return { writer, lines: out.lines, stderr: out.errors };
};

const page = (
  records: Record<string, unknown>[],
  warnings: Page<Record<string, unknown>>["warnings"] = [],
  duplicates = 0,
): Page<Record<string, unknown>> => ({ records, warnings, duplicates });

const rejection = (path: string) => ({
  kind: "record_rejected" as const,
  resource: "deal",
  path,
  issue: "invalid_type",
  message: `Invalid input at ${path}.`,
});

describe("warning deduplication", () => {
  test("stops emitting after 50 distinct causes and keeps counting", async () => {
    const { writer, lines } = writerOf();
    const causes = Array.from({ length: 60 }, (_, i) => rejection(`field_${i}`));

    writer.page(page([], causes));
    writer.finish(null);

    const written = lines().filter((line) => line["type"] === "warning");
    expect(written).toHaveLength(50);
    expect(written[49]?.["path"]).toBe("field_49");
    expect(lines().at(-1)).toMatchObject({ skipped: 60 });
  });

  test("a cause already seen is never re-emitted, even fifty causes later", async () => {
    const { writer, lines } = writerOf();

    writer.page(page([], [rejection("person_id")]));
    writer.page(page([], Array.from({ length: 60 }, (_, i) => rejection(`f${i}`))));
    writer.page(page([], [rejection("person_id")]));
    writer.finish(null);

    const paths = lines()
      .filter((line) => line["type"] === "warning")
      .map((line) => line["path"]);
    expect(paths.filter((path) => path === "person_id")).toHaveLength(1);
    expect(lines().at(-1)).toMatchObject({ skipped: 62 });
  });
});

describe("the single trailer", () => {
  test("finish refuses a second trailer, and it surfaces as internal", () => {
    const { writer } = writerOf();
    writer.finish(null);

    try {
      writer.finish(null);
      expect.unreachable();
    } catch (cause) {
      expect(isPdFailure(cause)).toBe(true);
      if (isPdFailure(cause)) {
        expect(cause.error.code).toBe("internal");
        expect(cause.error.exit_code).toBe(1);
      }
    }
  });

  test("a record written after the trailer is the same refusal", () => {
    const { writer } = writerOf();
    writer.error(pdError({ code: "upstream", message: "gone" }));

    expect(() => writer.page(page([{ id: 1 }]))).toThrow();
  });

  test("the error trailer goes to stdout and its message to stderr", () => {
    const { writer, lines, stderr } = writerOf();
    const exit = writer.error(
      pdError({ code: "rate_limited", message: "Burst spent.", retryAfterSeconds: 2 }),
    );

    expect(exit).toBe(3);
    expect(lines()).toEqual([
      {
        type: "error",
        code: "rate_limited",
        message: "Burst spent.",
        exit_code: 3,
        retry: "after",
        retry_after_seconds: 2,
        complete: false,
        emitted: 0,
        skipped: 0,
        duplicates: 0,
        resolved: "off",
        requests: 3,
        details: {},
      },
    ]);
    expect(stderr).toEqual(["pd: Burst spent.\n"]);
  });

  test("a bounded summary carries reason and complete: false", () => {
    const { writer, lines } = writerOf();
    writer.page(page([{ id: 1 }]));
    writer.finish("limit");

    expect(lines().at(-1)).toMatchObject({
      type: "summary",
      complete: false,
      emitted: 1,
      reason: "limit",
    });
  });
});

const pagesOf = async function* (
  ...pages: Result<Page<Record<string, unknown>>, PdError>[]
): AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>> {
  for (const value of pages) yield value;
};

describe("the collected path", () => {
  test("warnings precede every record, and the trailer is the same shape", async () => {
    const { writer, lines } = writerOf();

    const exit = await collect(
      pagesOf(
        ok(page([{ id: 1 }], [rejection("person_id")], 1)),
        ok(page([{ id: 2 }], [rejection("title")])),
      ),
      writer,
    );

    expect(exit).toBe(0);
    expect(lines().map((line) => line["type"])).toEqual([
      "warning",
      "warning",
      "record",
      "record",
      "summary",
    ]);
    expect(lines().at(-1)).toMatchObject({
      complete: true,
      emitted: 2,
      skipped: 2,
      duplicates: 1,
    });
  });

  test("on failure it emits 0 and writes none of the records it holds", async () => {
    const { writer, lines } = writerOf();

    const exit = await collect(
      pagesOf(
        ok(page([{ id: 1 }], [rejection("person_id")], 2)),
        err(pdError({ code: "upstream", message: "gone" })),
      ),
      writer,
    );

    expect(exit).toBe(1);
    expect(lines().filter((line) => line["type"] === "record")).toHaveLength(0);
    // skipped and duplicates were measured before the failure and are reported.
    expect(lines().at(-1)).toMatchObject({
      type: "error",
      emitted: 0,
      skipped: 1,
      duplicates: 2,
    });
  });

  test("the transform sees the whole set before a line is written", async () => {
    const { writer, lines } = writerOf();

    await collect(
      pagesOf(ok(page([{ id: 3 }, { id: 1 }])), ok(page([{ id: 2 }]))),
      writer,
      (records) =>
        [...records].sort((a, b) => (a["id"] as number) - (b["id"] as number)),
    );

    expect(
      lines()
        .filter((line) => line["type"] === "record")
        .map((line) => line["id"]),
    ).toEqual([1, 2, 3]);
  });
});

describe("the streaming loop", () => {
  test("a bound on a page ends the run with that reason", async () => {
    const { writer, lines } = writerOf();

    const exit = await stream(
      pagesOf(ok({ records: [{ id: 1 }], warnings: [], duplicates: 0, bound: "limit" })),
      writer,
    );

    expect(exit).toBe(0);
    expect(lines().at(-1)).toMatchObject({ complete: false, reason: "limit" });
  });

  test("an Err ends the run and the pages before it stay written", async () => {
    const { writer, lines } = writerOf();

    const exit = await stream(
      pagesOf(
        ok(page([{ id: 1 }])),
        err(pdError({ code: "invalid_response", message: "bad" })),
      ),
      writer,
    );

    expect(exit).toBe(1);
    expect(lines().filter((line) => line["type"] === "record")).toHaveLength(1);
    expect(lines().at(-1)).toMatchObject({ type: "error", emitted: 1 });
  });
});
