/**
 * `pd cache info` and `pd cache clear` — ADR-0005 §7, ADR-0009 §8, ADR-0010 §7.
 *
 * Both are local: zero HTTP requests, no credential resolved, one JSON object on
 * stdout. The tests drive `cacheCommand` directly rather than through `route`,
 * because ADR-0009 §8 puts these outside the resource grammar and `cli.ts` is
 * where they are wired — the same shape `auth-status.test.ts` uses for the other
 * named exception.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { cacheCommand, isCacheVerb } from "../src/commands/cache.ts";
import { SENTINEL_FILE } from "../src/lib/cache/entries.ts";
import { FakeClock } from "./support/clock.ts";

const FINGERPRINT = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const HOUR = 60 * 60 * 1000;

let home = "";
let clock = new FakeClock({ start: 1_770_000_000_000 });

const root = (): string => `${home}/cache/pd`;
const directory = (fingerprint = FINGERPRINT): string =>
  `${root()}/${fingerprint}`;

const place = (file: string, body: string, fingerprint = FINGERPRINT): void => {
  mkdirSync(directory(fingerprint), { recursive: true });
  writeFileSync(`${directory(fingerprint)}/${file}`, body);
};

const entry = (records: unknown[], fetchedAt = clock.now()): string =>
  JSON.stringify({ version: 1, fetched_at: fetchedAt, records });

type Run = { exit: number; report: Record<string, unknown>; stderr: string[] };

const run = (verb: "info" | "clear", argv: readonly string[] = []): Run => {
  const out: string[] = [];
  const errors: string[] = [];
  const exit = cacheCommand({
    verb,
    argv,
    platform: "linux",
    env: { XDG_CACHE_HOME: `${home}/cache` },
    home,
    clock,
    sink: (line) => out.push(line),
    stderr: (line) => errors.push(line),
  });
  return {
    exit,
    report: JSON.parse(out.join("")) as Record<string, unknown>,
    stderr: errors,
  };
};

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/pd-cache-commands-`);
  clock = new FakeClock({ start: 1_770_000_000_000 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("pd cache info", () => {
  test("reports the path, the entries and their ages", () => {
    place("users.json", entry([{ id: 1 }], clock.now() - 30_000));
    place("dealFields.json", entry([], clock.now() - HOUR));

    const { exit, report } = run("info");

    expect(exit).toBe(0);
    expect(report["path"]).toBe(root());
    expect(report["entries"]).toEqual(
      expect.arrayContaining([
        {
          credential: FINGERPRINT,
          entry: "users",
          ttl_seconds: 3600,
          age_seconds: 30,
          stale: false,
        },
        {
          credential: FINGERPRINT,
          entry: "dealFields",
          ttl_seconds: 86400,
          age_seconds: 3600,
          stale: false,
        },
      ]),
    );
  });

  test("an entry past its TTL is reported stale rather than hidden", () => {
    place("users.json", entry([], clock.now() - 2 * HOUR));

    expect(run("info").report["entries"]).toEqual([
      {
        credential: FINGERPRINT,
        entry: "users",
        ttl_seconds: 3600,
        age_seconds: 7200,
        stale: true,
      },
    ]);
  });

  test("a broken entry is reported unreadable rather than given an age", () => {
    place("stages.json", "{ half a file");

    expect(run("info").report["entries"]).toEqual([
      {
        credential: FINGERPRINT,
        entry: "stages",
        ttl_seconds: 86400,
        readable: false,
      },
    ]);
  });

  test("every credential's directory is listed, labelled by fingerprint", () => {
    place("users.json", entry([]));
    place("pipelines.json", entry([]), OTHER);

    const entries = run("info").report["entries"] as Record<string, unknown>[];
    expect(entries.map((line) => line["credential"]).sort()).toEqual(
      [FINGERPRINT, OTHER].sort(),
    );
  });

  test("an absent cache directory is an empty report, not a failure", () => {
    const { exit, report } = run("info");

    expect(exit).toBe(0);
    expect(report).toEqual({ path: root(), entries: [], blocked: [] });
  });

  test("the sentinel's presence and age are reported", () => {
    // ADR-0010 §7: a human debugging a refusal that made no requests has no
    // other way to see it.
    place(SENTINEL_FILE, JSON.stringify({ at: clock.now() }));

    const blocked = run("info").report["blocked"] as Record<string, unknown>[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.["credential"]).toBe(FINGERPRINT);
    expect(typeof blocked[0]?.["age_seconds"]).toBe("number");
  });

  test("the output is one JSON object, not NDJSON", () => {
    place("users.json", entry([]));
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

    expect(out.join("").trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("pd cache clear", () => {
  test("it empties the subtree and reports what it removed", () => {
    place("users.json", entry([]));
    place("dealFields.json", entry([]));
    place("stages.json", entry([]), OTHER);

    const { exit, report } = run("clear");

    expect(exit).toBe(0);
    expect(report).toEqual({ path: root(), removed: 3, preserved: 0 });
    expect(existsSync(directory())).toBe(false);
    expect(existsSync(directory(OTHER))).toBe(false);
  });

  test("it preserves the blocked sentinel", () => {
    // ADR-0010 §7: "clear the cache and retry" is an ordinary agent recovery
    // reflex, and deleting the sentinel would walk straight back into a
    // company-wide block.
    place("users.json", entry([]));
    place(SENTINEL_FILE, "{}");

    const { report } = run("clear");

    expect(report).toEqual({ path: root(), removed: 1, preserved: 1 });
    expect(existsSync(`${directory()}/${SENTINEL_FILE}`)).toBe(true);
    expect(existsSync(`${directory()}/users.json`)).toBe(false);
  });

  test("an absent cache directory clears successfully", () => {
    const { exit, report } = run("clear");

    expect(exit).toBe(0);
    expect(report).toMatchObject({ removed: 0, preserved: 0 });
  });

  test("a warm entry is gone afterwards", () => {
    place("users.json", entry([{ id: 1 }]));
    run("clear");

    expect(run("info").report["entries"]).toEqual([]);
  });
});

describe("the cli wires both, outside the resource grammar", () => {
  // `route()` never sees `cache`, so this is the one place the ADR-0009 §8
  // exception is exercised end to end. Run from source rather than from a
  // compiled binary: the wiring is the subject, and the build is not.
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  const pd = (...argv: string[]) =>
    Bun.spawnSync(["bun", cli, ...argv], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        XDG_CACHE_HOME: `${home}/cache`,
      },
    });

  test("pd cache info runs with no credential at all", () => {
    place("users.json", entry([{ id: 1 }]));

    const run = pd("cache", "info");

    expect(run.exitCode).toBe(0);
    const report = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
    expect(report["path"]).toBe(root());
    expect((report["entries"] as unknown[]).length).toBe(1);
  });

  test("pd cache clear runs, and an unknown verb is exit 2", () => {
    place("users.json", entry([]));

    expect(pd("cache", "clear").exitCode).toBe(0);
    expect(existsSync(`${directory()}/users.json`)).toBe(false);

    const bad = pd("cache", "purge");
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stdout.toString())["code"]).toBe("usage");
  });
});

describe("neither takes an argument, a pattern or a flag", () => {
  for (const argv of [["--all"], ["users"], ["--path", "/tmp"], ["*"]]) {
    test(`pd cache clear ${argv.join(" ")} is a usage error, exit 2`, () => {
      place("users.json", entry([]));
      const { exit, report, stderr } = run("clear", argv);

      expect(exit).toBe(2);
      expect(report).toMatchObject({ type: "error", code: "usage", exit_code: 2 });
      expect(stderr.join("")).toStartWith("pd: ");
      // Nothing was deleted: the refusal happens before the target is touched.
      expect(existsSync(`${directory()}/users.json`)).toBe(true);
    });
  }

  test("pd cache info takes none either", () => {
    expect(run("info", ["--verbose"]).exit).toBe(2);
  });

  test("info and clear are the only two verbs", () => {
    expect(isCacheVerb("info")).toBe(true);
    expect(isCacheVerb("clear")).toBe(true);
    expect(isCacheVerb("purge")).toBe(false);
    expect(isCacheVerb(undefined)).toBe(false);
  });
});
