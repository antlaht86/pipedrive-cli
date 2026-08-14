import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import { cachedPage, field, pipeline, stage, user, usersFixture } from "./support/cached.ts";
import { deal, dealsPage, dealsQuery, DEALS_PATH } from "./support/deals.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";

const HASH_ENUM = "1111111111111111111111111111111111111111";
const HASH_MONEY = "2222222222222222222222222222222222222222";
const HASH_TEXT = "3333333333333333333333333333333333333333";
const HASH_DUPLICATE = "4444444444444444444444444444444444444444";
const HASH_SET = "5555555555555555555555555555555555555555";
const HASH_USER = "6666666666666666666666666666666666666666";
const HASH_ADDRESS = "7777777777777777777777777777777777777777";

let home = "";
beforeEach(() => { home = mkdtempSync(`${tmpdir()}/pd-resolve-`); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const lookupFixtures = (fields: unknown[]): Fixture[] => [
  cachedPage("dealFields", fields),
  usersFixture([user(11), user(12)]),
  cachedPage("pipelines", [pipeline(1)]),
  cachedPage("stages", [stage(4)]),
];

const dealFixture = (records: unknown[], cursor?: string): Fixture => ({
  path: DEALS_PATH,
  query: dealsQuery(cursor),
  body: dealsPage(records, null),
});

const run = async (fixtures: readonly Fixture[], argv: readonly string[] = []) => {
  const out = capture();
  const exit = await route({
    argv: ["deals", "list", "--resolve", ...argv],
    platform: "linux",
    env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
    home,
    transport: createReplayTransport(fixtures),
    sink: out.sink,
    stderr: out.stderr,
  });
  return { exit, lines: out.lines(), last: out.last() as Line };
};

const records = (lines: Line[]) => lines.filter((line) => line.type === "record");
const warnings = (lines: Line[]) => lines.filter((line) => line.type === "warning");

describe("--resolve fixed-cost enrichment", () => {
  test("the same flag resolves standard references on cached records", async () => {
    const out = capture();
    const exit = await route({
      argv: ["stages", "list", "--resolve"],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      transport: createReplayTransport([
        cachedPage("stages", [stage(4)]),
        cachedPage("pipelines", [pipeline(1)]),
      ]),
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(exit).toBe(0);
    expect(out.of("record")[0]).toMatchObject({
      id: 4,
      pipeline_id: 1,
      pipeline_name: "Sales 1",
    });
    expect(out.last()).toMatchObject({ resolved: "full", requests: 2 });
  });

  test("adds fixed reference names and hash-keyed custom field metadata without changing raw values", async () => {
    const fields = [
      field(HASH_ENUM, { field_name: "Renewal", options: [{ id: 1, label: "Annual", color: null, update_time: null, add_time: null }] }),
      field(HASH_MONEY, { field_name: "Budget", field_type: "monetary", options: null }),
      field(HASH_TEXT, { field_name: "Shared name", field_type: "varchar", options: null }),
      field(HASH_DUPLICATE, { field_name: "Shared name", field_type: "text", options: null }),
      field(HASH_SET, { field_name: "Regions", field_type: "set", options: [
        { id: 1, label: "North", color: null, update_time: null, add_time: null },
        { id: 2, label: "South", color: null, update_time: null, add_time: null },
      ] }),
      field(HASH_USER, { field_name: "Reviewer", field_type: "user", options: null }),
      field(HASH_ADDRESS, { field_name: "Office", field_type: "address", options: null }),
    ];
    const custom = {
      [HASH_ENUM]: 1,
      [HASH_MONEY]: { value: 12000, currency: "EUR" },
      [HASH_TEXT]: "unchanged",
      [HASH_DUPLICATE]: "also unchanged",
      [HASH_SET]: [1, 2],
      [HASH_USER]: 12,
      [HASH_ADDRESS]: ["Mannerheimintie 1", "00100 Helsinki", "Finland"],
    };
    const raw = deal(1, { owner_id: 12, pipeline_id: 1, stage_id: 4, custom_fields: custom });
    const { exit, lines, last } = await run([
      ...lookupFixtures(fields),
      dealFixture([raw]),
    ]);

    expect(exit).toBe(0);
    const record = records(lines)[0] as Line;
    expect(record.owner_id).toBe(12);
    expect(record.owner_name).toBe("Aino Virtanen 12");
    expect(record.pipeline_name).toBe("Sales 1");
    expect(record.stage_name).toBe("Qualified 4");
    expect(JSON.stringify(record.custom_fields)).toBe(JSON.stringify(custom));
    expect(record.custom_fields_resolved).toEqual({
      [HASH_ENUM]: { name: "Renewal", label: "Annual" },
      [HASH_MONEY]: { name: "Budget", label: "12000.00 EUR" },
      [HASH_TEXT]: { name: "Shared name" },
      [HASH_DUPLICATE]: { name: "Shared name" },
      [HASH_SET]: { name: "Regions", label: ["North", "South"] },
      [HASH_USER]: { name: "Reviewer", label: "Aino Virtanen 12" },
      [HASH_ADDRESS]: { name: "Office", label: "Mannerheimintie 1, 00100 Helsinki, Finland" },
    });
    expect(last).toMatchObject({ resolved: "full", requests: 5 });
  });

  test("omits sibling names for ids absent from otherwise available lists", async () => {
    const { lines, last } = await run([
      ...lookupFixtures([]),
      dealFixture([deal(1, { owner_id: 999, pipeline_id: 999, stage_id: 999 })]),
    ]);
    const record = records(lines)[0] as Line;
    expect("owner_name" in record).toBe(false);
    expect("pipeline_name" in record).toBe(false);
    expect("stage_name" in record).toBe(false);
    expect(last.resolved).toBe("full");
  });

  test("a failed ancillary lookup degrades to raw ids, warns once, and exits zero", async () => {
    const fixtures: Fixture[] = [
      cachedPage("dealFields", []),
      { path: "/v1/users", status: 403, body: { success: false } },
      cachedPage("pipelines", [pipeline(1)]),
      cachedPage("stages", [stage(4)]),
      dealFixture([deal(1, { owner_id: 12, stage_id: 4 })]),
    ];
    const { exit, lines, last } = await run(fixtures);

    expect(exit).toBe(0);
    expect((records(lines)[0] as Line).owner_name).toBeUndefined();
    expect((records(lines)[0] as Line).stage_name).toBe("Qualified 4");
    expect(warnings(lines).filter((line) => line.kind === "owner_resolution_unavailable")).toHaveLength(1);
    expect(last).toMatchObject({ type: "summary", resolved: "partial" });
  });

  test("projection prefetches only selected resolvers and carries the sibling artifact", async () => {
    const { exit, lines, last } = await run([
      usersFixture([user(12)]),
      dealFixture([deal(1, { owner_id: 12 })]),
    ], ["--fields", "owner_id"]);

    expect(exit).toBe(0);
    expect(records(lines)[0]).toEqual({
      type: "record",
      record_type: "deal",
      id: 1,
      owner_id: 12,
      owner_name: "Aino Virtanen 12",
    });
    expect(last).toMatchObject({ resolved: "full", requests: 2 });
  });

  test("warm lookup caches cost zero extra requests", async () => {
    const fields = [field(HASH_ENUM)];
    const first = await run([
      ...lookupFixtures(fields),
      dealFixture([deal(1, { stage_id: 4, custom_fields: { [HASH_ENUM]: 1 } })]),
    ]);
    expect(first.last.requests).toBe(5);

    const second = await run([
      dealFixture([deal(2, { stage_id: 4, custom_fields: { [HASH_ENUM]: 1 } })]),
    ]);
    expect(second.exit).toBe(0);
    expect(second.last).toMatchObject({ resolved: "full", requests: 1 });
  });

  test("an unknown hash refreshes its schema once per run and warns once", async () => {
    const unknownA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const unknownB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const seen: string[] = [];
    const replay = createReplayTransport([
      cachedPage("dealFields", []),
      cachedPage("dealFields", []),
      usersFixture([user(11)]),
      cachedPage("pipelines", [pipeline(1)]),
      cachedPage("stages", [stage(4)]),
      {
        path: DEALS_PATH,
        query: dealsQuery(),
        body: dealsPage([deal(1, { custom_fields: { [unknownA]: 1 } })], "c2"),
      },
      {
        path: DEALS_PATH,
        query: dealsQuery("c2"),
        body: dealsPage([deal(2, { custom_fields: { [unknownB]: 2 } })], null),
      },
    ]);
    const out = capture();
    const exit = await route({
      argv: ["deals", "list", "--resolve"],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      transport: (request) => { seen.push(new URL(request.url).pathname); return replay(request); },
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(exit).toBe(0);
    expect(seen.filter((path) => path === "/api/v2/dealFields")).toHaveLength(2);
    expect(out.of("warning").filter((line) => line.kind === "unknown_custom_field")).toHaveLength(1);
    expect(out.last()).toMatchObject({ resolved: "partial", requests: 7 });
  });

  test("never sends include_option_labels", async () => {
    const seen: string[] = [];
    const replay = createReplayTransport([
      ...lookupFixtures([field(HASH_ENUM)]),
      dealFixture([deal(1, { custom_fields: { [HASH_ENUM]: 1 } })]),
    ]);
    const out = capture();
    const exit = await route({
      argv: ["deals", "list", "--resolve"],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      transport: (request) => { seen.push(request.url); return replay(request); },
      sink: out.sink,
      stderr: out.stderr,
    });
    expect(exit).toBe(0);
    expect(seen.every((url) => !url.includes("include_option_labels"))).toBe(true);
  });
});
