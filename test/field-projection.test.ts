import { describe, expect, test } from "bun:test";

import { route } from "../src/router.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { deal } from "./support/deals.ts";
import { user, usersFixture } from "./support/cached.ts";
import { LIVE, getRecord, listPage, product } from "./support/records.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const run = async (fixtures: readonly Fixture[] | undefined, argv: readonly string[]) => {
  const out = capture();
  const exit = await route({
    argv,
    platform: "linux",
    env: { PD_API_TOKEN: "test-token" },
    home: "/home/nobody",
    ...(fixtures === undefined ? {} : { transport: createReplayTransport(fixtures) }),
    sink: out.sink,
    stderr: out.stderr,
  });
  return { exit, lines: out.lines(), stderr: out.errors };
};

const records = (lines: Line[]) => lines.filter((line) => line["type"] === "record");

describe("--fields projection", () => {
  test("repeatable comma lists accumulate, deduplicate, and retain identity", async () => {
    const fixture = listPage(LIVE[0]!, [deal(42)], null);
    const { exit, lines } = await run([fixture], [
      "deals", "list", "--fields", "value,title", "--fields", "title,org_id",
    ]);

    expect(exit).toBe(0);
    expect(records(lines)).toEqual([{
      type: "record",
      record_type: "deal",
      id: 42,
      title: "Acme Oy — annual licence 2020",
      org_id: 902,
      value: 13554,
    }]);
  });

  test("unknown and artifact selectors are refused offline with a correction", async () => {
    const unknown = await run(undefined, ["deals", "list", "--fields", "titel"]);
    expect(unknown.exit).toBe(2);
    expect(unknown.lines[0]?.["message"]).toContain("Valid fields: id, title");

    const artifact = await run(undefined, ["deals", "list", "--fields", "org_name"]);
    expect(artifact.exit).toBe(2);
    expect(String(artifact.lines[0]?.["message"]).toLowerCase()).toContain("select org_id instead");
  });

  test("one custom hash is pushed down and projected without include_fields", async () => {
    const fixture = listPage(
      LIVE[0]!,
      [deal(42, { custom_fields: { [HASH_A]: "kept" } })],
      null,
    );
    fixture.query = { ...fixture.query, custom_fields: HASH_A };
    let requested = "";
    const replay = createReplayTransport([fixture]);
    const out = capture();
    await route({
      argv: ["deals", "list", "--fields", `custom_fields.${HASH_A}`],
      platform: "linux",
      env: { PD_API_TOKEN: "test-token" },
      home: "/home/nobody",
      transport: (request) => { requested = request.url; return replay(request); },
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(new URL(requested).searchParams.get("custom_fields")).toBe(HASH_A);
    expect(new URL(requested).searchParams.has("include_fields")).toBe(false);
    expect(records(out.lines())[0]).toEqual({
      type: "record", record_type: "deal", id: 42,
      custom_fields: { [HASH_A]: "kept" },
    });
  });

  test("push-down and local trimming emit byte-identical product records", async () => {
    const source = product(7, { custom_fields: { [HASH_A]: "kept", [HASH_B]: "trimmed" } });
    const pushed = listPage(LIVE[4]!, [{ ...source, custom_fields: { [HASH_A]: "kept" } }], null);
    pushed.query = { ...pushed.query, custom_fields: HASH_A };
    const local = getRecord(LIVE[4]!, 7, { custom_fields: source.custom_fields });

    const fromList = await run([pushed], ["products", "list", "--fields", `custom_fields.${HASH_A}`]);
    const fromGet = await run([local], ["products", "get", "7", "--fields", `custom_fields.${HASH_A}`]);

    expect(fromList.exit).toBe(0);
    expect(fromGet.exit).toBe(0);
    expect(JSON.stringify(records(fromList.lines)[0])).toBe(JSON.stringify(records(fromGet.lines)[0]));
  });

  test("bare custom_fields and more than fifteen hashes fall back to local trimming", async () => {
    const hashes = Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(40, "0"));
    for (const selected of ["custom_fields", hashes.map((hash) => `custom_fields.${hash}`).join(",")]) {
      const fixture = listPage(LIVE[0]!, [deal(1)], null);
      let requested = "";
      const replay = createReplayTransport([fixture]);
      const out = capture();
      const exit = await route({
        argv: ["deals", "list", "--fields", selected],
        platform: "linux",
        env: { PD_API_TOKEN: "test-token" },
        home: "/home/nobody",
        transport: (request) => { requested = request.url; return replay(request); },
        sink: out.sink,
        stderr: out.stderr,
      });

      expect(exit).toBe(0);
      expect(new URL(requested).searchParams.has("custom_fields")).toBe(false);
      expect(new URL(requested).searchParams.has("include_fields")).toBe(false);
    }
  });

  test("an unmatched hash warns once after the whole walk without skipping records", async () => {
    const first = listPage(LIVE[0]!, [deal(1)], "next");
    first.query = { ...first.query, custom_fields: HASH_A };
    const second = listPage(LIVE[0]!, [deal(2)], null, "next");
    second.query = { ...second.query, custom_fields: HASH_A };
    const { lines } = await run([first, second], ["deals", "list", "--fields", `custom_fields.${HASH_A}`]);

    expect(lines.filter((line) => line["kind"] === "unmatched_field_selector")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ emitted: 2, skipped: 0 });
  });

  test("an unmatched hash still warns when --limit ends generator consumption", async () => {
    const fixture = listPage(LIVE[0]!, [deal(1), deal(2)], "not-consumed");
    fixture.query = { ...fixture.query, custom_fields: HASH_A };
    const { lines } = await run([fixture], [
      "deals", "list", "--limit", "1", "--fields", `custom_fields.${HASH_A}`,
    ]);

    expect(lines.filter((line) => line["kind"] === "unmatched_field_selector")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ emitted: 1, skipped: 0, reason: "limit" });
  });

  test("cached resources use the same offline projection contract", async () => {
    const { exit, lines } = await run([usersFixture([user(11)])], [
      "users", "list", "--fields", "email",
    ]);

    expect(exit).toBe(0);
    expect(records(lines)[0]).toEqual({
      type: "record",
      record_type: "user",
      id: 11,
      email: "aino.11@example.invalid",
    });
  });

  test("deeper paths are usage errors and empty selected values only shorten a line", async () => {
    expect((await run(undefined, ["products", "list", "--fields", "prices.price"])).exit).toBe(2);

    const { lines } = await run([listPage(LIVE[0]!, [deal(1, { close_time: null })], null)], [
      "deals", "list", "--fields", "close_time",
    ]);
    expect(records(lines)[0]).toEqual({ type: "record", record_type: "deal", id: 1 });
  });
});
