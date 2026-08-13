/**
 * The four cached resources — ticket 08's acceptance criteria.
 *
 * Every test drives the real router through fixture replay (ADR-0019 §2) with a
 * temporary `XDG_CACHE_HOME` and the fake clock (ADR-0019 §4, §5). There is no
 * test-only flag and no injected filesystem: the TTL, the `0600` mode, the
 * temp-plus-rename and the "no credential on disk" property are statements about
 * a real file in a real directory the test owns and deletes.
 *
 * The default transport throws, so a request a test did not record fails the run
 * rather than reaching Pipedrive — which is also how "a warm cache makes no
 * request" is asserted: the second run is given **no fixtures at all**.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import { fingerprintOf } from "../src/lib/auth/credentials.ts";
import { CACHED_RESOURCES } from "../src/lib/pipedrive/cached.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { FakeClock } from "./support/clock.ts";
import { cachedPage, field, pipeline, stage, user, usersFixture } from "./support/cached.ts";

const TOKEN = "test-token";
const HOUR = 60 * 60 * 1000;

let home = "";
let clock = new FakeClock({ start: 1_770_000_000_000 });

type Run = { exit: number; lines: Line[]; stderr: string[]; last: Line };

const runWith = async (
  fixtures: readonly Fixture[] | undefined,
  argv: readonly string[],
): Promise<Run> => {
  const out = capture();
  const exit = await route({
    argv,
    platform: "linux",
    env: { PD_API_TOKEN: TOKEN, XDG_CACHE_HOME: `${home}/cache` },
    home,
    clock,
    ...(fixtures === undefined
      ? {}
      : { transport: createReplayTransport(fixtures) }),
    sink: out.sink,
    stderr: out.stderr,
  });
  const lines = out.lines();
  return { exit, lines, stderr: out.errors, last: lines.at(-1) as Line };
};

const records = (lines: Line[]): Line[] =>
  lines.filter((line) => line["type"] === "record");

const warnings = (lines: Line[]): Line[] =>
  lines.filter((line) => line["type"] === "warning");

const cacheDirectory = (): string =>
  `${home}/cache/pd/${fingerprintOf(TOKEN)}`;

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/pd-cached-`);
  clock = new FakeClock({ start: 1_770_000_000_000 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the four cached resources are routed", () => {
  test("the table holds exactly users, pipelines, stages and fields", () => {
    expect([...CACHED_RESOURCES]).toEqual([
      "users",
      "pipelines",
      "stages",
      "fields",
    ]);
  });
});

describe("pd users list", () => {
  test("reads the narrow v1 client and emits user records", async () => {
    const { exit, lines, last } = await runWith(
      [usersFixture([user(11), user(12)])],
      ["users", "list"],
    );

    expect(exit).toBe(0);
    expect(records(lines).map((line) => line["id"])).toEqual([11, 12]);
    expect(records(lines)[0]).toMatchObject({
      record_type: "user",
      name: "Aino Virtanen 11",
      email: "aino.11@example.invalid",
    });
    expect(last).toEqual({
      type: "summary",
      complete: true,
      emitted: 2,
      skipped: 0,
      duplicates: 0,
      resolved: "off",
      requests: 1,
    });
  });

  test("the record carries only the fields ADR-0007 §3 keeps", async () => {
    const { lines } = await runWith([usersFixture([user(11)])], ["users", "list"]);

    expect(Object.keys(records(lines)[0] as Line)).toEqual([
      "type",
      "record_type",
      "id",
      "name",
      "email",
      "active_flag",
      "is_deleted",
      "timezone_name",
    ]);
  });

  test("the request goes to v1, and no v1-ness reaches stdout", async () => {
    const replay = createReplayTransport([usersFixture([user(11)])]);
    let url = "";
    const out = capture();

    await route({
      argv: ["users", "list"],
      platform: "linux",
      env: { PD_API_TOKEN: TOKEN, XDG_CACHE_HOME: `${home}/cache` },
      home,
      clock,
      transport: (request) => {
        url = request.url;
        return replay(request);
      },
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(url).toBe("https://api.pipedrive.com/v1/users");
    expect(out.lines().map((line) => JSON.stringify(line)).join("")).not.toContain(
      "success",
    );
  });

  test("a users fetch failure is fatal — the list is the answer", async () => {
    const { exit, lines, last } = await runWith(
      [{ path: "/v1/users", status: 403, body: { success: false } }],
      ["users", "list"],
    );

    expect(exit).toBe(1);
    expect(records(lines)).toHaveLength(0);
    expect(last).toMatchObject({
      type: "error",
      code: "forbidden",
      complete: false,
      emitted: 0,
    });
  });

  test("a deactivated user is included", async () => {
    // ADR-0007 §5: `owner_id` on a two-year-old deal often points at someone
    // who has left, and a resolver that cannot name them fails at exactly the
    // moment the name is most needed.
    const { lines } = await runWith(
      [usersFixture([user(11, { active_flag: false, is_deleted: true })])],
      ["users", "list"],
    );

    expect(records(lines)[0]).toMatchObject({
      active_flag: false,
      is_deleted: true,
    });
  });
});

describe("pipelines and stages", () => {
  test("pd pipelines list walks every page", async () => {
    const { exit, lines, last } = await runWith(
      [
        cachedPage("pipelines", [pipeline(1), pipeline(2)], "c2"),
        cachedPage("pipelines", [pipeline(3)], null, "c2"),
      ],
      ["pipelines", "list"],
    );

    expect(exit).toBe(0);
    expect(records(lines).map((line) => line["id"])).toEqual([1, 2, 3]);
    expect(last).toMatchObject({ complete: true, emitted: 3, requests: 2 });
  });

  test("pd stages list tags the singular record_type", async () => {
    const { lines } = await runWith(
      [cachedPage("stages", [stage(1)])],
      ["stages", "list"],
    );

    expect(records(lines)[0]).toMatchObject({ record_type: "stage", id: 1 });
  });
});

describe("pd fields list", () => {
  test("--entity deal lists the account's field codes beside their names", async () => {
    const { exit, lines, last } = await runWith(
      [
        cachedPage("dealFields", [
          field("9a3f1c2b4d5e6f708192a3b4c5d6e7f809a1b2c3"),
          field("title", { is_custom_field: false, field_type: "varchar", options: null }),
        ]),
      ],
      ["fields", "list", "--entity", "deal"],
    );

    expect(exit).toBe(0);
    expect(records(lines).map((line) => line["field_code"])).toEqual([
      "9a3f1c2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
      "title",
    ]);
    expect(records(lines)[0]).toMatchObject({
      record_type: "field",
      field_name: "Renewal quarter 9a3f",
    });
    expect(last).toMatchObject({ complete: true, emitted: 2, requests: 1 });
  });

  for (const entity of ["person", "organization", "product", "activity"]) {
    test(`--entity ${entity} reads its own endpoint`, async () => {
      const { exit, lines } = await runWith(
        [cachedPage(`${entity}Fields`, [field("abc")])],
        ["fields", "list", "--entity", entity],
      );

      expect(exit).toBe(0);
      expect(records(lines)).toHaveLength(1);
    });
  }

  test("without --entity it is a usage error, exit 2, and no request", async () => {
    const { exit, lines, last } = await runWith(undefined, ["fields", "list"]);

    expect(exit).toBe(2);
    expect(records(lines)).toHaveLength(0);
    expect(last).toMatchObject({ type: "error", code: "usage", exit_code: 2 });
    expect(String(last["message"])).toContain("requires --entity");
    expect(String(last["message"])).toContain(
      "deal, person, organization, product, activity",
    );
  });

  test("an entity pd does not have is a usage error naming the five", async () => {
    const { exit, last } = await runWith(undefined, [
      "fields",
      "list",
      "--entity",
      "lead",
    ]);

    expect(exit).toBe(2);
    expect(last["code"]).toBe("usage");
    expect(String(last["message"])).toContain("'lead'");
  });

  test("--entity does not exist on the other cached resources", async () => {
    const { exit, last } = await runWith(undefined, [
      "users",
      "list",
      "--entity",
      "deal",
    ]);

    expect(exit).toBe(2);
    expect(String(last["message"])).toContain("does not accept --entity");
  });
});

describe("a warm cache costs no request", () => {
  test("the second run reports requests: 0 with no fixtures at all", async () => {
    const first = await runWith([usersFixture([user(11)])], ["users", "list"]);
    expect(first.last["requests"]).toBe(1);

    // No transport is passed: a request here would be a missing-fixture
    // failure, which is the strongest available statement of "none was made".
    const second = await runWith(undefined, ["users", "list"]);

    expect(second.exit).toBe(0);
    expect(records(second.lines).map((line) => line["id"])).toEqual([11]);
    expect(second.last).toMatchObject({ complete: true, emitted: 1, requests: 0 });
  });

  test("a cache hit does not count against --max-requests", async () => {
    await runWith([cachedPage("pipelines", [pipeline(1)])], ["pipelines", "list"]);

    // A ceiling of 1 with the entry already warm: the run makes no network
    // request, so the guard has nothing to count and nothing to refuse.
    const warm = await runWith(undefined, [
      "pipelines",
      "list",
      "--max-requests",
      "1",
    ]);

    expect(warm.exit).toBe(0);
    expect(warm.last).toMatchObject({ complete: true, requests: 0 });
  });

  test("the eight entries carry their stated TTLs", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);
    await runWith([cachedPage("dealFields", [field("abc")])], [
      "fields",
      "list",
      "--entity",
      "deal",
    ]);

    clock.advance(2 * HOUR);

    // The user list is an hour old and refetches; the field schema is 24 hours
    // and does not, which is why the run below needs only the one fixture.
    const users = await runWith([usersFixture([user(11), user(12)])], ["users", "list"]);
    expect(users.last["requests"]).toBe(1);
    expect(records(users.lines)).toHaveLength(2);

    const fields = await runWith(undefined, ["fields", "list", "--entity", "deal"]);
    expect(fields.last["requests"]).toBe(0);

    clock.advance(23 * HOUR);
    const stale = await runWith([cachedPage("dealFields", [field("abc")])], [
      "fields",
      "list",
      "--entity",
      "deal",
    ]);
    expect(stale.last["requests"]).toBe(1);
  });

  test("nothing but the eight entries is ever written", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);
    await runWith([cachedPage("stages", [stage(1)])], ["stages", "list"]);

    expect(readdirSync(cacheDirectory()).sort()).toEqual([
      "stages.json",
      "users.json",
    ]);
  });

  test("a deal list writes no cache entry at all", async () => {
    // ADR-0005 §1: no entity records, no result sets, no search results, ever.
    const { exit } = await runWith(
      [
        {
          path: "/api/v2/deals",
          query: { limit: 500 },
          body: {
            success: true,
            data: [],
            additional_data: { next_cursor: null },
          },
        },
      ],
      ["deals", "list"],
    );

    expect(exit).toBe(0);
    // Not "the directory is empty" but "there is no directory": a live resource
    // never touches the cache surface at all.
    expect(existsSync(`${home}/cache/pd`)).toBe(false);
  });
});

describe("the cache is keyed by the credential", () => {
  test("the directory is the first 16 hex of the token's SHA-256", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const fingerprint = fingerprintOf(TOKEN);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(readdirSync(`${home}/cache/pd`)).toEqual([fingerprint]);
  });

  test("no credential string is ever written into a cache file", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const body = readFileSync(`${cacheDirectory()}/users.json`, "utf8");
    expect(body).not.toContain(TOKEN);
  });

  test("the entry is mode 0600 and carries a schema version", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const path = `${cacheDirectory()}/users.json`;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))["version"]).toBe(1);
  });

  test("a second credential does not read the first one's entry", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const out = capture();
    const exit = await route({
      argv: ["users", "list"],
      platform: "linux",
      env: { PD_API_TOKEN: "a-different-token", XDG_CACHE_HOME: `${home}/cache` },
      home,
      clock,
      transport: createReplayTransport([usersFixture([user(99)])]),
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(exit).toBe(0);
    expect(out.of("record").map((line) => line["id"])).toEqual([99]);
    expect(readdirSync(`${home}/cache/pd`).sort()).toEqual(
      [fingerprintOf(TOKEN), fingerprintOf("a-different-token")].sort(),
    );
  });
});

describe("a broken entry is skipped, refetched and reported", () => {
  const corrupt = (name: string, body: string): void => {
    mkdirSync(cacheDirectory(), { recursive: true });
    writeFileSync(`${cacheDirectory()}/${name}`, body);
  };

  test("one cache_entry_skipped warning, and the run succeeds", async () => {
    corrupt("users.json", "{ half a file");

    const { exit, lines, last } = await runWith(
      [usersFixture([user(11)])],
      ["users", "list"],
    );

    expect(exit).toBe(0);
    expect(warnings(lines)).toHaveLength(1);
    expect(warnings(lines)[0]).toMatchObject({
      type: "warning",
      kind: "cache_entry_skipped",
      entry: "users",
    });
    expect(last).toMatchObject({ complete: true, emitted: 1, requests: 1 });
  });

  test("the refetched answer replaces the broken entry", async () => {
    corrupt("stages.json", "not json");
    await runWith([cachedPage("stages", [stage(1)])], ["stages", "list"]);

    const warm = await runWith(undefined, ["stages", "list"]);
    expect(warm.exit).toBe(0);
    expect(warm.last["requests"]).toBe(0);
  });

  test("an unrecognised schema version is silent, not a warning", async () => {
    corrupt(
      "users.json",
      JSON.stringify({ version: 99, fetched_at: clock.now(), records: [] }),
    );

    const { exit, lines } = await runWith(
      [usersFixture([user(11)])],
      ["users", "list"],
    );

    expect(exit).toBe(0);
    expect(warnings(lines)).toHaveLength(0);
  });
});

describe("cached data is validated on read", () => {
  test("a record the schema rejects is a warning and skipped, warm or cold", async () => {
    const bad = user(12, { name: 42 });

    const cold = await runWith(
      [usersFixture([user(11), bad])],
      ["users", "list"],
    );
    expect(cold.exit).toBe(0);
    expect(records(cold.lines).map((line) => line["id"])).toEqual([11]);
    expect(cold.last).toMatchObject({ emitted: 1, skipped: 1, requests: 1 });

    // The same list, now from disk: the same warning and the same counters,
    // which is what "--no-cache cannot change what pd accepts" means.
    const warm = await runWith(undefined, ["users", "list"]);
    expect(warm.exit).toBe(0);
    expect(records(warm.lines).map((line) => line["id"])).toEqual([11]);
    expect(warm.last).toMatchObject({ emitted: 1, skipped: 1, requests: 0 });
    expect(warnings(warm.lines)[0]).toMatchObject({ kind: "record_rejected" });
  });

  test("a warm entry no record of which survives is refetched, not reported", async () => {
    mkdirSync(cacheDirectory(), { recursive: true });
    writeFileSync(
      `${cacheDirectory()}/pipelines.json`,
      JSON.stringify({
        version: 1,
        fetched_at: clock.now(),
        // A shape a past schema accepted and this binary does not.
        records: [{ pipeline: 1 }],
      }),
    );

    const { exit, lines, last } = await runWith(
      [cachedPage("pipelines", [pipeline(1)])],
      ["pipelines", "list"],
    );

    expect(exit).toBe(0);
    expect(records(lines).map((line) => line["id"])).toEqual([1]);
    expect(last).toMatchObject({ complete: true, requests: 1 });
  });

  test("a cold fetch none of whose records survive is invalid_response", async () => {
    const { exit, last } = await runWith(
      [cachedPage("stages", [{ stage: 1 }, { stage: 2 }])],
      ["stages", "list"],
    );

    expect(exit).toBe(1);
    expect(last).toMatchObject({
      type: "error",
      code: "invalid_response",
      emitted: 0,
      complete: false,
    });
  });
});

describe("--no-cache skips the read and still writes", () => {
  test("a warm entry is bypassed and replaced", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const fresh = await runWith(
      [usersFixture([user(11), user(12)])],
      ["users", "list", "--no-cache"],
    );
    expect(fresh.last).toMatchObject({ emitted: 2, requests: 1 });

    // One run restores the normal path: the next ordinary run is warm again,
    // and warm on the *new* answer.
    const warm = await runWith(undefined, ["users", "list"]);
    expect(warm.last).toMatchObject({ emitted: 2, requests: 0 });
  });

  test("it does not exist on the live resources", async () => {
    const { exit, last } = await runWith(undefined, ["deals", "list", "--no-cache"]);

    expect(exit).toBe(2);
    expect(String(last["message"])).toContain("does not accept --no-cache");
  });
});

describe("get filters the cached list", () => {
  test("pd pipelines get 2 costs zero requests on a warm cache", async () => {
    await runWith(
      [cachedPage("pipelines", [pipeline(1), pipeline(2)])],
      ["pipelines", "list"],
    );

    const { exit, lines, last } = await runWith(undefined, ["pipelines", "get", "2"]);

    expect(exit).toBe(0);
    expect(records(lines)).toHaveLength(1);
    expect(records(lines)[0]).toMatchObject({ record_type: "pipeline", id: 2 });
    expect(last).toEqual({
      type: "summary",
      complete: true,
      emitted: 1,
      skipped: 0,
      duplicates: 0,
      resolved: "off",
      requests: 0,
    });
  });

  test("pd fields get --entity deal takes a non-integer id", async () => {
    const code = "9a3f1c2b4d5e6f708192a3b4c5d6e7f809a1b2c3";
    await runWith(
      [cachedPage("dealFields", [field(code), field("title")])],
      ["fields", "list", "--entity", "deal"],
    );

    const { exit, lines, last } = await runWith(undefined, [
      "fields",
      "get",
      "--entity",
      "deal",
      code,
    ]);

    expect(exit).toBe(0);
    expect(records(lines)[0]).toMatchObject({ field_code: code });
    expect(last).toMatchObject({ complete: true, emitted: 1, requests: 0 });
  });

  test("a standard field code — not a hash — is found too", async () => {
    await runWith(
      [cachedPage("dealFields", [field("title", { is_custom_field: false })])],
      ["fields", "list", "--entity", "deal"],
    );

    const { exit, lines } = await runWith(undefined, [
      "fields",
      "get",
      "--entity",
      "deal",
      "title",
    ]);

    expect(exit).toBe(0);
    expect(records(lines)[0]).toMatchObject({ field_code: "title" });
  });

  test("an id absent from a warm list forces one refetch", async () => {
    // ADR-0005 §3 and ADR-0007 §4: a user who joined this morning is found
    // regardless of the TTL, at the cost of one request.
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const { exit, lines, last } = await runWith(
      [usersFixture([user(11), user(12)])],
      ["users", "get", "12"],
    );

    expect(exit).toBe(0);
    expect(records(lines)[0]).toMatchObject({ id: 12 });
    expect(last).toMatchObject({ complete: true, emitted: 1, requests: 1 });
  });

  test("an id absent after the refetch is not_found, exit 1", async () => {
    await runWith([usersFixture([user(11)])], ["users", "list"]);

    const { exit, lines, last } = await runWith(
      [usersFixture([user(11)])],
      ["users", "get", "77"],
    );

    expect(exit).toBe(1);
    expect(records(lines)).toHaveLength(0);
    expect(last).toMatchObject({
      type: "error",
      code: "not_found",
      exit_code: 1,
      retry: "never",
      complete: false,
      emitted: 0,
    });
  });

  test("a cold get fetches once and does not fetch twice on a miss", async () => {
    const { exit, last } = await runWith(
      [cachedPage("stages", [stage(1)])],
      ["stages", "get", "9"],
    );

    expect(exit).toBe(1);
    expect(last).toMatchObject({ code: "not_found", requests: 1 });
  });

  test("only the matched record is validated", async () => {
    // A neighbour the schema would reject must not produce a `record_rejected`
    // warning on a `get` the caller aimed elsewhere.
    const { exit, lines } = await runWith(
      [cachedPage("stages", [stage(1), { stage: "broken" }])],
      ["stages", "get", "1"],
    );

    expect(exit).toBe(0);
    expect(warnings(lines)).toHaveLength(0);
  });

  test("a matched record the schema rejects is invalid_response", async () => {
    const { exit, last } = await runWith(
      [cachedPage("pipelines", [pipeline(1), pipeline(2, { name: 42 })])],
      ["pipelines", "get", "2"],
    );

    expect(exit).toBe(1);
    expect(last).toMatchObject({ code: "invalid_response", emitted: 0 });
  });

  test("a non-integer id is a usage error on a resource whose ids are integers", async () => {
    const { exit, last } = await runWith(undefined, ["users", "get", "abc"]);

    expect(exit).toBe(2);
    expect(last["code"]).toBe("usage");
  });
});

describe("--limit bounds a cached list", () => {
  test("a limit below the count truncates and says so", async () => {
    const { exit, lines, last } = await runWith(
      [usersFixture([user(11), user(12), user(13)])],
      ["users", "list", "--limit", "2"],
    );

    expect(exit).toBe(0);
    expect(records(lines).map((line) => line["id"])).toEqual([11, 12]);
    expect(last).toMatchObject({
      type: "summary",
      complete: false,
      emitted: 2,
      reason: "limit",
    });
  });

  test("a limit at the count is a complete answer", async () => {
    const { last } = await runWith(
      [usersFixture([user(11), user(12)])],
      ["users", "list", "--limit", "2"],
    );

    expect(last).toMatchObject({ complete: true, emitted: 2 });
    expect(last["reason"]).toBeUndefined();
  });

  test("--limit does not exist on get", async () => {
    const { exit, last } = await runWith(undefined, [
      "users",
      "get",
      "11",
      "--limit",
      "1",
    ]);

    expect(exit).toBe(2);
    expect(String(last["message"])).toContain("does not accept --limit");
  });
});
