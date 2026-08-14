import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import { cachedPage, field, pipeline, stage, usersFixture } from "./support/cached.ts";
import { deal, dealsPage, dealsQuery, DEALS_PATH } from "./support/deals.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { organization, person } from "./support/records.ts";
import { FakeClock } from "./support/clock.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";

const PERSON_HASH = "1111111111111111111111111111111111111111";

let home = "";
beforeEach(() => { home = mkdtempSync(`${tmpdir()}/pd-resolve-variable-`); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const personBatch = (ids: readonly number[]): Fixture => ({
  path: "/api/v2/persons",
  query: { ids: ids.join(",") },
  body: { success: true, data: ids.map((id) => person(id)), additional_data: { next_cursor: null } },
});

const organizationBatch = (ids: readonly number[]): Fixture => ({
  path: "/api/v2/organizations",
  query: { ids: ids.join(",") },
  body: { success: true, data: ids.map((id) => organization(id)), additional_data: { next_cursor: null } },
});

const metadata = (): Fixture[] => [
  cachedPage("dealFields", [field(PERSON_HASH, { field_name: "Introducer", field_type: "people", options: null })]),
  usersFixture([]),
  cachedPage("pipelines", [pipeline(1)]),
  cachedPage("stages", [stage(4)]),
];

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

describe("--resolve variable-cost enrichment", () => {
  test("resolves standard and custom person relations in page-local batches of 100 with a run map", async () => {
    const firstIds = Array.from({ length: 101 }, (_, index) => 5_001 + index);
    const firstPage = firstIds.map((id, index) => deal(index + 1, {
      person_id: id,
      custom_fields: { [PERSON_HASH]: id },
    }));
    const secondPage = [deal(200, {
      person_id: firstIds[0],
      custom_fields: { [PERSON_HASH]: 6_000 },
    })];

    const { exit, lines, last } = await run([
      ...metadata(),
      { path: DEALS_PATH, query: { ...dealsQuery(), custom_fields: PERSON_HASH }, body: dealsPage(firstPage, "c2") },
      personBatch(firstIds.slice(0, 100)),
      personBatch(firstIds.slice(100)),
      { path: DEALS_PATH, query: { ...dealsQuery("c2"), custom_fields: PERSON_HASH }, body: dealsPage(secondPage, null) },
      personBatch([6_000]),
    ], ["--fields", `person_id,custom_fields.${PERSON_HASH}`]);

    expect(exit).toBe(0);
    expect(records(lines)[0]).toMatchObject({
      person_id: 5_001,
      person_name: "Aino Virtanen 5001",
      custom_fields_resolved: {
        [PERSON_HASH]: { name: "Introducer", label: "Aino Virtanen 5001" },
      },
    });
    expect(records(lines).at(-1)).toMatchObject({
      person_id: 5_001,
      person_name: "Aino Virtanen 5001",
      custom_fields_resolved: {
        [PERSON_HASH]: { name: "Introducer", label: "Aino Virtanen 6000" },
      },
    });
    expect(last).toMatchObject({ resolved: "full", requests: 7 });
  });

  test("emits the first resolved page before requesting the next walk page", async () => {
    const events: string[] = [];
    const replay = createReplayTransport([
      { path: DEALS_PATH, query: dealsQuery(), body: dealsPage([deal(1, { person_id: 8_201 })], "c2") },
      personBatch([8_201]),
      { path: DEALS_PATH, query: dealsQuery("c2"), body: dealsPage([deal(2, { person_id: 8_202 })], null) },
      personBatch([8_202]),
    ]);
    const out = capture();
    const exit = await route({
      argv: ["deals", "list", "--resolve", "--fields", "person_id"],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      transport: (request) => {
        events.push(request.url.includes("cursor=c2") ? "request:c2" : "request:first");
        return replay(request);
      },
      sink: (line) => {
        if (line.includes('"type":"record"') && line.includes('"id":1')) {
          events.push("record:1");
        }
        out.sink(line);
      },
      stderr: out.stderr,
    });

    expect(exit).toBe(0);
    expect(events.indexOf("record:1")).toBeLessThan(events.indexOf("request:c2"));
  });

  test("--fields reduces relation requests by projecting before prefetch", async () => {
    const source = deal(1, { person_id: 8_101, org_id: 9_101 });
    const full = await run([
      ...metadata(),
      { path: DEALS_PATH, query: dealsQuery(), body: dealsPage([source], null) },
      personBatch([8_101]),
      organizationBatch([9_101]),
    ]);
    expect(full.exit).toBe(0);
    expect(records(full.lines)[0]).toMatchObject({
      person_name: "Aino Virtanen 8101",
      org_name: "Acme Oy 9101",
    });

    const projected = await run([
      { path: DEALS_PATH, query: dealsQuery(), body: dealsPage([source], null) },
      personBatch([8_101]),
    ], ["--fields", "person_id"]);
    expect(projected.exit).toBe(0);
    expect(projected.last.requests).toBeLessThan(full.last.requests as number);
    expect(projected.last).toMatchObject({ requests: 2, resolved: "full" });
  });

  test("yields relation enrichment before consuming the last --max-requests slot", async () => {
    const { exit, lines, last } = await run([
      { path: DEALS_PATH, query: dealsQuery(), body: dealsPage([deal(1, { person_id: 8_001 })], null) },
    ], ["--fields", "person_id", "--max-requests", "2"]);

    expect(exit).toBe(0);
    expect(records(lines)[0]?.person_name).toBeUndefined();
    expect(warnings(lines).filter((line) => line.kind === "resolution_budget_exhausted")).toHaveLength(1);
    expect(last).toMatchObject({ type: "summary", resolved: "partial", requests: 1 });
  });

  test("uses a default relation ceiling of 50 requests", async () => {
    const fixtures: Fixture[] = [];
    for (let index = 0; index < 51; index += 1) {
      const cursor = index === 0 ? undefined : `c${index}`;
      const next = index === 50 ? null : `c${index + 1}`;
      const relationId = 10_000 + index;
      fixtures.push({
        path: DEALS_PATH,
        query: dealsQuery(cursor),
        body: dealsPage([deal(index + 1, { person_id: relationId })], next),
      });
      if (index < 50) fixtures.push(personBatch([relationId]));
    }

    const out = capture();
    const exit = await route({
      argv: ["deals", "list", "--resolve", "--fields", "person_id"],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      transport: createReplayTransport(fixtures),
      clock: new FakeClock(),
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(exit).toBe(0);
    expect(out.of("record")).toHaveLength(51);
    expect(out.of("warning").filter((line) => line.kind === "resolution_budget_exhausted")).toHaveLength(1);
    expect(out.last()).toMatchObject({ resolved: "partial", requests: 101 });
  });

  test("stops relation batches at --resolve-budget, warns once, and exits zero with raw remaining ids", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => 7_001 + index);
    const source = ids.map((id, index) => deal(index + 1, { person_id: id }));
    const { exit, lines, last } = await run([
      { path: DEALS_PATH, query: dealsQuery(), body: dealsPage(source, null) },
      personBatch(ids.slice(0, 100)),
    ], ["--fields", "person_id", "--resolve-budget", "1"]);

    expect(exit).toBe(0);
    expect(records(lines)[0]?.person_name).toBe("Aino Virtanen 7001");
    expect(records(lines)[100]?.person_name).toBeUndefined();
    expect(warnings(lines).filter((line) => line.kind === "resolution_budget_exhausted")).toHaveLength(1);
    expect(last).toMatchObject({ type: "summary", resolved: "partial", requests: 2 });
  });
});
