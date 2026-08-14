/**
 * The `blocked` sentinel end to end — ticket 09's acceptance criteria.
 *
 * Every test drives the real router with a temporary `XDG_CACHE_HOME` and the
 * fake clock (ADR-0019 §4, §5): there is no test-only flag and no injected
 * filesystem, so "the sentinel expires after fifteen minutes" is a statement
 * about a real file that a real command wrote.
 *
 * "Zero HTTP requests" is asserted twice over, and deliberately. A refusing run
 * is given **no transport at all**, so the default throwing one turns a stray
 * request into a failed test rather than a wrong number; and the trailer's
 * `requests` counter is checked as well, because that is the number an agent
 * reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import { cacheCommand } from "../src/commands/cache.ts";
import { fingerprintOf } from "../src/lib/auth/credentials.ts";
import {
  SENTINEL_FILE,
  SENTINEL_SCHEMA_VERSION,
  SENTINEL_TTL_SECONDS,
} from "../src/lib/cache/entries.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { DEALS_PATH, deal, dealsPage, dealsQuery } from "./support/deals.ts";
import { user, usersFixture } from "./support/cached.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { FakeClock } from "./support/clock.ts";

const TOKEN = "test-token";
const OTHER_TOKEN = "other-token";
const TTL_MS = SENTINEL_TTL_SECONDS * 1000;

let home = "";
let clock = new FakeClock({ start: 1_770_000_000_000 });

type Run = { exit: number; lines: Line[]; stderr: string[]; last: Line };

const runAs = async (
  token: string,
  fixtures: readonly Fixture[] | undefined,
  argv: readonly string[],
): Promise<Run> => {
  const out = capture();
  const exit = await route({
    argv,
    platform: "linux",
    env: { PD_API_TOKEN: token, XDG_CACHE_HOME: `${home}/cache` },
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

const run = (
  fixtures: readonly Fixture[] | undefined,
  argv: readonly string[] = ["deals", "list"],
): Promise<Run> => runAs(TOKEN, fixtures, argv);

const cacheInfo = (): Record<string, unknown> => {
  const out: string[] = [];
  cacheCommand({
    verb: "info",
    argv: [],
    platform: "linux",
    env: { XDG_CACHE_HOME: `${home}/cache` },
    home,
    clock,
    sink: (line) => out.push(line),
    stderr: () => undefined,
  });
  return JSON.parse(out.join("")) as Record<string, unknown>;
};

const cacheClear = (): Record<string, unknown> => {
  const out: string[] = [];
  cacheCommand({
    verb: "clear",
    argv: [],
    platform: "linux",
    env: { XDG_CACHE_HOME: `${home}/cache` },
    home,
    clock,
    sink: (line) => out.push(line),
    stderr: () => undefined,
  });
  return JSON.parse(out.join("")) as Record<string, unknown>;
};

const directory = (token = TOKEN): string =>
  `${home}/cache/pd/${fingerprintOf(token)}`;

const sentinelPath = (token = TOKEN): string =>
  `${directory(token)}/${SENTINEL_FILE}`;

const place = (body: string): void => {
  mkdirSync(directory(), { recursive: true });
  writeFileSync(sentinelPath(), body);
};

/** The Cloudflare block: a 403 whose body is an HTML error page, never JSON. */
const CLOUDFLARE: Fixture = {
  path: DEALS_PATH,
  query: dealsQuery(),
  status: 403,
  headers: { "content-type": "text/html" },
  body: "<!doctype html><html>Attention Required! | Cloudflare</html>",
};

const dealsFixture: Fixture = {
  path: DEALS_PATH,
  query: dealsQuery(),
  body: dealsPage([deal(1)], null),
};

/** Meets the block once, which is what every test below starts from. */
const meetTheBlock = async (): Promise<Run> => run([CLOUDFLARE]);

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/pd-blocked-`);
  clock = new FakeClock({ start: 1_770_000_000_000 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("meeting the block", () => {
  test("a Cloudflare 403 refuses this run and writes the sentinel", async () => {
    const { exit, last } = await meetTheBlock();

    expect(exit).toBe(3);
    expect(last).toMatchObject({
      code: "blocked",
      exit_code: 3,
      retry: "not_today",
    });
    expect(existsSync(sentinelPath())).toBe(true);
  });

  test("the sentinel lands under the credential's own directory", async () => {
    await meetTheBlock();

    expect(existsSync(sentinelPath(OTHER_TOKEN))).toBe(false);
  });

  test("an ordinary failure writes nothing", async () => {
    const { exit } = await run([
      { path: DEALS_PATH, query: dealsQuery(), status: 401, body: {} },
    ]);

    expect(exit).toBe(1);
    expect(existsSync(sentinelPath())).toBe(false);
  });

  test("a JSON 403 is a permission failure and writes nothing", async () => {
    // ADR-0001: 403 is overloaded, and the two are separated by body shape.
    const { exit, last } = await run([
      { path: DEALS_PATH, query: dealsQuery(), status: 403, body: {} },
    ]);

    expect(exit).toBe(1);
    expect(last["code"]).toBe("forbidden");
    expect(existsSync(sentinelPath())).toBe(false);
  });
});

describe("while the sentinel is live", () => {
  test("the next invocation refuses with zero requests", async () => {
    await meetTheBlock();

    // No transport at all: a request would fail the test rather than be counted.
    const { exit, last } = await run(undefined);

    expect(exit).toBe(3);
    expect(last).toMatchObject({
      type: "error",
      code: "blocked",
      exit_code: 3,
      retry: "not_today",
      complete: false,
      requests: 0,
      emitted: 0,
    });
  });

  test("the refusal says it came from memory rather than from a response", async () => {
    await meetTheBlock();
    const { last } = await run(undefined);

    expect((last["details"] as Record<string, unknown>)["source"]).toBe(
      "sentinel",
    );
  });

  test("stderr carries the human half of the same refusal", async () => {
    await meetTheBlock();
    const { stderr } = await run(undefined);

    expect(stderr.join("")).toContain("pd: ");
    expect(stderr.join("")).toContain("no request");
  });

  test("every resource refuses, cached and live alike", async () => {
    await meetTheBlock();

    for (const argv of [
      ["deals", "list"],
      ["deals", "get", "1"],
      ["persons", "list"],
      ["users", "list"],
      ["fields", "list", "--entity", "deal"],
    ]) {
      const { exit, last } = await run(undefined, argv);
      expect(exit).toBe(3);
      expect(last["code"]).toBe("blocked");
    }
  });

  test("fifty invocations meet one block, not fifty fresh retry caps", async () => {
    await meetTheBlock();
    for (let i = 0; i < 50; i += 1) {
      clock.advance(10_000);
      const { exit } = await run(undefined);
      expect(exit).toBe(3);
    }

    // Fifty refusals later the block still ends fifteen minutes after it began,
    // rather than fifteen minutes after the most recent attempt.
    clock.advance(TTL_MS + 1);
    const { exit } = await run([dealsFixture]);
    expect(exit).toBe(0);
  });

  test("another credential on the same machine is unaffected", async () => {
    await meetTheBlock();

    const { exit } = await runAs(OTHER_TOKEN, [dealsFixture], ["deals", "list"]);
    expect(exit).toBe(0);
  });
});

describe("the fifteen minutes", () => {
  test("one millisecond short of the expiry the refusal stands", async () => {
    await meetTheBlock();
    clock.advance(TTL_MS - 1);

    const { exit, last } = await run(undefined);
    expect(exit).toBe(3);
    expect(last["code"]).toBe("blocked");
  });

  test("past the expiry the next run tries once for real", async () => {
    await meetTheBlock();
    clock.advance(TTL_MS + 1);

    const { exit, last } = await run([dealsFixture]);
    expect(exit).toBe(0);
    expect(last["requests"]).toBe(1);
    expect(existsSync(sentinelPath())).toBe(false);
  });

  test("and it can be blocked again, which starts a fresh fifteen minutes", async () => {
    await meetTheBlock();
    clock.advance(TTL_MS + 1);
    await meetTheBlock();

    clock.advance(TTL_MS - 1);
    const { exit } = await run(undefined);
    expect(exit).toBe(3);
  });
});

describe("nothing in the flag surface reaches it", () => {
  test("--no-cache does not bypass it", async () => {
    // ADR-0010 §7: `--no-cache` is defined over cached *data*. "Retry with
    // --no-cache" is exactly as ordinary an agent recovery reflex as "clear the
    // cache and retry", and neither may walk back into the block.
    await meetTheBlock();

    const { exit, last } = await run(undefined, ["users", "list", "--no-cache"]);
    expect(exit).toBe(3);
    expect(last["code"]).toBe("blocked");
    expect(last["requests"]).toBe(0);
  });

  test("--no-cache does not bypass it on a warm cache either", async () => {
    await runAs(TOKEN, [usersFixture([user(11)])], ["users", "list"]);
    await meetTheBlock();

    const { exit, last } = await run(undefined, ["users", "list", "--no-cache"]);
    expect(exit).toBe(3);
    expect(last["code"]).toBe("blocked");
  });

  test("a warm cache does not serve past it either", async () => {
    // The sentinel is above the cache read, not beside it: a credential that is
    // blocked gets no answer at all, warm entry or not.
    await runAs(TOKEN, [usersFixture([user(11)])], ["users", "list"]);
    await meetTheBlock();

    const { exit, last } = await run(undefined, ["users", "list"]);
    expect(exit).toBe(3);
    expect(last["code"]).toBe("blocked");
  });

  test("there is no override flag, in any spelling", async () => {
    await meetTheBlock();

    for (const flag of [
      "--ignore-block",
      "--ignore-blocked",
      "--force",
      "--no-block",
      "--unblock",
    ]) {
      const { exit, last } = await run(undefined, ["deals", "list", flag]);
      // A flag that does not exist is a usage error, which is the proof that it
      // does not exist: no spelling of it reaches the network.
      expect(exit).toBe(2);
      expect(last["code"]).toBe("usage");
      expect(last["requests"]).toBe(0);
    }
  });

  test("no environment variable overrides it", async () => {
    await meetTheBlock();

    const out = capture();
    const exit = await route({
      argv: ["deals", "list"],
      platform: "linux",
      env: {
        PD_API_TOKEN: TOKEN,
        XDG_CACHE_HOME: `${home}/cache`,
        PD_IGNORE_BLOCK: "1",
        PD_FORCE: "1",
        PD_NO_SENTINEL: "1",
      },
      home,
      clock,
      sink: out.sink,
      stderr: out.stderr,
    });

    expect(exit).toBe(3);
    expect(out.last()?.["code"]).toBe("blocked");
  });
});

describe("pd cache clear preserves it", () => {
  test("the subtree goes and the sentinel stays", async () => {
    await runAs(TOKEN, [usersFixture([user(11)])], ["users", "list"]);
    await meetTheBlock();

    const report = cacheClear();

    expect(report).toMatchObject({ removed: 1, preserved: 1 });
    expect(existsSync(`${directory()}/users.json`)).toBe(false);
    expect(existsSync(sentinelPath())).toBe(true);
  });

  test("and the run after the clear still refuses", async () => {
    await meetTheBlock();
    cacheClear();

    const { exit, last } = await run(undefined);
    expect(exit).toBe(3);
    expect(last["code"]).toBe("blocked");
  });
});

describe("pd cache info explains a request-free refusal", () => {
  test("it reports the sentinel, its age and its remaining life", async () => {
    await meetTheBlock();
    clock.advance(5 * 60_000);

    const blocked = cacheInfo()["blocked"] as Record<string, unknown>[];

    expect(blocked).toEqual([
      {
        credential: fingerprintOf(TOKEN),
        age_seconds: 5 * 60,
        expires_in_seconds: SENTINEL_TTL_SECONDS - 5 * 60,
      },
    ]);
  });

  test("a sentinel past its life reports no life left", async () => {
    await meetTheBlock();
    clock.advance(TTL_MS + 60_000);

    const blocked = cacheInfo()["blocked"] as Record<string, unknown>[];
    expect(blocked[0]).toMatchObject({ expires_in_seconds: 0 });
  });

  test("a sentinel pd would ignore is reported unreadable, not as a block", async () => {
    place("{ not json at all");

    const blocked = cacheInfo()["blocked"] as Record<string, unknown>[];
    expect(blocked).toEqual([
      { credential: fingerprintOf(TOKEN), readable: false },
    ]);
  });
});

describe("an unparseable sentinel is treated as absent", () => {
  test("a file that is not JSON lets the run proceed", async () => {
    place("<html>not a sentinel</html>");

    const { exit, last } = await run([dealsFixture]);
    expect(exit).toBe(0);
    expect(last["requests"]).toBe(1);
  });

  test("a file of the wrong shape lets the run proceed", async () => {
    place(JSON.stringify({ at: clock.now() }));

    const { exit } = await run([dealsFixture]);
    expect(exit).toBe(0);
  });

  test("a version this binary does not know lets the run proceed", async () => {
    place(
      JSON.stringify({
        version: SENTINEL_SCHEMA_VERSION + 1,
        blocked_at: clock.now(),
      }),
    );

    const { exit } = await run([dealsFixture]);
    expect(exit).toBe(0);
  });

  test("and it is left on disk for a human to look at", async () => {
    place("{ not json at all");
    await run([dealsFixture]);

    expect(existsSync(sentinelPath())).toBe(true);
  });
});
