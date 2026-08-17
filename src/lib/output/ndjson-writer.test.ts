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

const writerOf = (
  bounded = false,
): {
  writer: NdjsonWriter;
  lines: () => Line[];
  stderr: string[];
} => {
  const out = capture();
  const writer = new NdjsonWriter({
    recordType: "deal",
    requests: () => 3,
    bounded,
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

/**
 * ADR-0003's size warning. Twenty thousand records is the cheapest honest test
 * of "every 10,000" — the threshold is deliberately not injectable, because a
 * knob that exists only for a test is the surface ADR-0019 §5 forbids.
 */
describe("the unbounded-run size warning", () => {
  const many = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1 }));

  test("an unbounded run warns on stderr at every 10,000 emitted records", () => {
    const { writer, stderr } = writerOf();
    writer.records(many(20_001));
    writer.finish(null);

    expect(stderr).toEqual([
      "pd: 10000 records emitted so far. Pass --limit to bound the walk.\n",
      "pd: 20000 records emitted so far. Pass --limit to bound the walk.\n",
    ]);
  });

  test("it says nothing below the first threshold", () => {
    const { writer, stderr } = writerOf();
    writer.records(many(9_999));
    writer.finish(null);

    expect(stderr).toEqual([]);
  });

  test("stdout is untouched by it", () => {
    const { writer, lines } = writerOf();
    writer.records(many(10_000));
    writer.finish(null);

    expect(lines().filter((line) => line["type"] === "record")).toHaveLength(10_000);
    expect(lines().at(-1)).toMatchObject({ type: "summary", emitted: 10_000 });
  });

  test("a bounded run is not warned about the size it asked for", () => {
    const { writer, stderr } = writerOf(true);
    writer.records(many(20_000));
    writer.finish("limit");

    expect(stderr).toEqual([]);
  });

  test("the warning survives the page boundaries it straddles", () => {
    // The counter is cumulative and lives on the writer, so a run that arrives
    // as forty pages of 500 warns in the same place as one that arrives whole.
    const { writer, stderr } = writerOf();
    for (let i = 0; i < 40; i += 1) {
      writer.records(
        Array.from({ length: 500 }, (_, j) => ({ id: i * 500 + j + 1 })),
      );
    }
    writer.finish(null);

    expect(stderr).toHaveLength(2);
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

describe("a record field never shadows a line key", () => {
  const shadow = (record: Record<string, unknown>): unknown => {
    const out = capture();
    const writer = new NdjsonWriter({
      recordType: "activity",
      requests: () => 1,
      rename: { type: "activity_type" },
      sink: out.sink,
      stderr: out.stderr,
    });
    try {
      writer.records([record]);
      return undefined;
    } catch (cause) {
      return cause;
    }
  };

  test("the configured rename moves the field out of the way", () => {
    const out = capture();
    const writer = new NdjsonWriter({
      recordType: "activity",
      requests: () => 1,
      rename: { type: "activity_type" },
      sink: out.sink,
      stderr: out.stderr,
    });

    writer.records([{ id: 1, type: "call" }]);

    expect(out.lines()[0]).toEqual({
      type: "record",
      record_type: "activity",
      id: 1,
      activity_type: "call",
    });
  });

  test("a rename landing on a field the record already has is internal", () => {
    // The guard exists for the regeneration nobody reviews: renaming `type` onto
    // an `activity_type` the record grew would overwrite it and ship.
    const cause = shadow({ id: 1, type: "call", activity_type: "already here" });

    expect(isPdFailure(cause)).toBe(true);
    expect((cause as { error: PdError }).error).toMatchObject({
      code: "internal",
      exit_code: 1,
      details: { field: "type", renamed_to: "activity_type" },
    });
  });

  /**
   * ADR-0029 §6: a reserved name that came off the wire is Pipedrive's doing,
   * not `pd`'s, so it costs one record rather than the run.
   */
  test("a bare reserved name off the wire is one rejection, not a throw", () => {
    const out = capture();
    const writer = new NdjsonWriter({
      recordType: "activity",
      requests: () => 1,
      sink: out.sink,
      stderr: out.stderr,
    });

    writer.records([{ id: 1 }, { id: 2, record_type: "sneaky" }, { id: 3 }]);
    writer.finish(null);

    expect(out.lines().filter((line) => line["type"] === "record")).toHaveLength(
      2,
    );
    expect(out.lines().at(-1)).toMatchObject({ emitted: 2, skipped: 1 });
    // The warning is raised where the record was met, so unlike `hold`'s it sits
    // between two `record` lines rather than ahead of them. Both are on stdout
    // before the trailer, which is what ADR-0002 actually promises.
    expect(out.lines().filter((line) => line["type"] === "warning")).toEqual([
      {
        type: "warning",
        kind: "record_rejected",
        resource: "activity",
        path: "record_type",
        issue: "shadowed",
        message:
          "This activity record carries a field named 'record_type', which " +
          "would shadow the line's own key. The record is skipped; pd cannot " +
          "emit it without losing a field.",
      },
    ]);
  });

  test("the trailer it writes carries the records that really went out", () => {
    // A bug is precisely when a counter must not lie: two records are already
    // on stdout when the third collides, and `emitted: 0` would retract them.
    const out = capture();
    const writer = new NdjsonWriter({
      recordType: "activity",
      requests: () => 4,
      rename: { type: "activity_type" },
      sink: out.sink,
      stderr: out.stderr,
    });

    const raised = ((): unknown => {
      try {
        writer.records([
          { id: 1 },
          { id: 2 },
          { id: 3, type: "call", activity_type: "no" },
        ]);
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    expect(isPdFailure(raised)).toBe(true);
    expect(out.last()).toMatchObject({
      type: "error",
      code: "internal",
      complete: false,
      emitted: 2,
      requests: 4,
    });
    // One stderr line, from the writer. `cli.ts` reads the marker and adds none.
    expect(out.errors).toHaveLength(1);
    expect(
      (raised as { error: PdError }).error.details?.["trailer_already_written"],
    ).toBe(true);
  });

  test("a rename that would land on an existing field is internal too", () => {
    // The same silent loss, one step further along: the resource grew its own
    // `activity_type` and the rename would overwrite it.
    const cause = shadow({ id: 1, type: "call", activity_type: "already here" });

    expect(isPdFailure(cause)).toBe(true);
    expect((cause as { error: PdError }).error).toMatchObject({
      code: "internal",
      details: { field: "type", renamed_to: "activity_type" },
    });
  });
});
