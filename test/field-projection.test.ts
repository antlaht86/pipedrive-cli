import { describe, expect, test } from "bun:test";

import { route } from "../src/router.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { deal } from "./support/deals.ts";
import { cachedPage, field, user, usersFixture } from "./support/cached.ts";
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
  return { exit, stdout: out.text(), lines: out.lines(), stderr: out.errors };
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

  /**
   * ADR-0016 §9's property, re-asserted after ADR-0029 changed what it rests
   * on. Projection iterates the record rather than the selectors, so the order
   * it emits used to be the generated schema's and is now the wire's. What the
   * ADR actually promises — two callers selecting the same fields in different
   * orders get byte-identical records — survives the change, and this is the
   * test that says so.
   */
  test("selector order does not reach the output, whatever order the wire used", async () => {
    const wire = { value: 13554, id: 42, title: "Acme Oy", org_id: 902 };
    const one = await run([listPage(LIVE[0]!, [wire], null)], [
      "deals", "list", "--fields", "title,org_id,value",
    ]);
    const other = await run([listPage(LIVE[0]!, [wire], null)], [
      "deals", "list", "--fields", "value,title,org_id",
    ]);

    expect(one.stdout).toBe(other.stdout);
    expect(one.stdout.split("\n")[0]).toBe(
      '{"type":"record","record_type":"deal","value":13554,"id":42,"title":"Acme Oy","org_id":902}',
    );
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
    expect(fromList.stdout).toBe(fromGet.stdout);
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

  /**
   * ADR-0030 §5. "Matched" means survived into the output, so a hash nobody has
   * filled reads as unmatched — which is the case ADR-0016 §6 already named when
   * it chose a warning over an error. ADR-0016 §5 keeps the record itself.
   */
  test("a hash that is null in every record warns and leaves the block empty", async () => {
    const fixture = listPage(LIVE[0]!, [
      deal(1, { custom_fields: { [HASH_A]: null } }),
      deal(2, { custom_fields: { [HASH_A]: null } }),
    ], null);
    fixture.query = { ...fixture.query, custom_fields: HASH_A };
    const { lines } = await run([fixture], ["deals", "list", "--fields", `custom_fields.${HASH_A}`]);

    expect(records(lines)).toEqual([
      { type: "record", record_type: "deal", id: 1, custom_fields: {} },
      { type: "record", record_type: "deal", id: 2, custom_fields: {} },
    ]);
    expect(lines.filter((line) => line["kind"] === "unmatched_field_selector")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ emitted: 2, skipped: 0 });
  });

  test("a hash filled in one record of the walk does not warn", async () => {
    const fixture = listPage(LIVE[0]!, [
      deal(1, { custom_fields: { [HASH_A]: null } }),
      deal(2, { custom_fields: { [HASH_A]: "kept" } }),
    ], null);
    fixture.query = { ...fixture.query, custom_fields: HASH_A };
    const { lines } = await run([fixture], ["deals", "list", "--fields", `custom_fields.${HASH_A}`]);

    expect(records(lines)[1]).toMatchObject({ custom_fields: { [HASH_A]: "kept" } });
    expect(lines.filter((line) => line["kind"] === "unmatched_field_selector")).toHaveLength(0);
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

  test("field_code remains as the followable identity of projected field records", async () => {
    const { exit, lines } = await run(
      [cachedPage("dealFields", [field(HASH_A)])],
      ["fields", "list", "--entity", "deal", "--fields", "field_name"],
    );

    expect(exit).toBe(0);
    expect(records(lines)[0]).toEqual({
      type: "record",
      record_type: "field",
      field_name: "Renewal quarter aaaa",
      field_code: HASH_A,
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
