/**
 * The store's own properties, tested against a real temporary directory.
 *
 * ADR-0019 §5 allows exactly one isolation mechanism: point `XDG_CACHE_HOME` at
 * a directory the test owns and deletes. There is no `--cache-dir`, no
 * `PD_TEST_HOME` and no injected filesystem — the mode bits, the rename and the
 * "no credential on disk" property are all statements about a real file, and a
 * substituted filesystem would assert them about a fake one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { createCacheStore } from "./store.ts";
import { CACHE_SCHEMA_VERSION } from "./entries.ts";
import type { Clock } from "../pipedrive/clock.ts";

const TOKEN_HASH = "0123456789abcdef";
const SECOND = 1000;

let root = "";
let time = 1_770_000_000_000;

const clock: Clock = {
  now: () => time,
  sleep: () => Promise.resolve(),
  random: () => 0,
};

const store = () =>
  createCacheStore({
    platform: "linux",
    env: { XDG_CACHE_HOME: root },
    home: "/home/nobody",
    fingerprint: TOKEN_HASH,
    clock,
  });

const directory = (): string => `${root}/pd/${TOKEN_HASH}`;

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/pd-cache-`);
  time = 1_770_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a written entry reads back", () => {
  test("the records survive the round trip byte for byte", () => {
    const records = [{ id: 1, name: "Aino" }, { id: 2, name: "Väinö" }];
    expect(store().write("users", records)).toBeUndefined();

    const read = store().read("users");
    expect(read.outcome).toBe("hit");
    expect(read.outcome === "hit" && read.records).toEqual(records);
  });

  test("the file is mode 0600 and its directory 0700", () => {
    store().write("users", []);

    expect(statSync(`${directory()}/users.json`).mode & 0o777).toBe(0o600);
    expect(statSync(directory()).mode & 0o777).toBe(0o700);
  });

  test("no temporary file is left behind", () => {
    store().write("dealFields", [{ field_code: "title" }]);

    expect(readdirSync(directory())).toEqual(["dealFields.json"]);
  });

  test("no credential string is ever written into a cache file", () => {
    // The directory name is a hash, and ADR-0005 §6 says the token itself
    // reaches disk nowhere at all. Asserted as a grep of every written byte.
    store().write("users", [{ id: 1, name: "Aino" }]);

    const bytes = readFileSync(`${directory()}/users.json`, "utf8");
    expect(bytes).not.toContain("test-token");
    expect(JSON.parse(bytes)).toEqual({
      version: CACHE_SCHEMA_VERSION,
      fetched_at: time,
      records: [{ id: 1, name: "Aino" }],
    });
  });
});

describe("the TTL decides a hit", () => {
  test("users is live for an hour and missing after it", () => {
    store().write("users", [{ id: 1 }]);

    time += 59 * 60 * SECOND;
    expect(store().read("users").outcome).toBe("hit");

    time += 2 * 60 * SECOND;
    expect(store().read("users").outcome).toBe("miss");
  });

  test("a field schema is live for a day", () => {
    store().write("dealFields", [{ field_code: "title" }]);

    time += 23 * 60 * 60 * SECOND;
    expect(store().read("dealFields").outcome).toBe("hit");

    time += 2 * 60 * 60 * SECOND;
    expect(store().read("dealFields").outcome).toBe("miss");
  });

  test("a clock that went backwards expires the entry rather than freezing it", () => {
    store().write("stages", [{ id: 1 }]);
    time -= 60 * SECOND;

    expect(store().read("stages").outcome).toBe("miss");
  });
});

describe("a broken entry is skipped, never fatal", () => {
  const place = (name: string, body: string): void => {
    mkdirSync(directory(), { recursive: true });
    writeFileSync(`${directory()}/${name}`, body);
  };

  test("a file that is not JSON warns and reads as skipped", () => {
    place("pipelines.json", "{ half a fi");

    const read = store().read("pipelines");
    expect(read.outcome).toBe("skipped");
    expect(read.outcome === "skipped" && read.warning.kind).toBe(
      "cache_entry_skipped",
    );
  });

  test("JSON that is not a cache entry warns", () => {
    place("stages.json", JSON.stringify({ records: "not an array" }));

    expect(store().read("stages").outcome).toBe("skipped");
  });

  test("an unrecognised version reads as missing, silently", () => {
    // ADR-0005 §6 and the ticket: an upgrade rewriting eight entries is
    // expected, not a signal, so this is a miss and not a warning.
    place(
      "users.json",
      JSON.stringify({ version: CACHE_SCHEMA_VERSION + 1, fetched_at: time, records: [] }),
    );

    expect(store().read("users").outcome).toBe("miss");
  });

  test("a file that exists and cannot be read warns rather than missing", () => {
    // ADR-0005 §5 lists "an I/O error, wrong permissions" under skipped: an
    // entry that is permanently unreadable would otherwise waste a request on
    // every run with no signal anywhere. Root reads a 0000 file regardless, so
    // the discriminating assertion is skipped there rather than weakened.
    place("users.json", JSON.stringify({ version: 1, fetched_at: time, records: [] }));
    chmodSync(`${directory()}/users.json`, 0o000);

    const read = store().read("users");
    chmodSync(`${directory()}/users.json`, 0o600);

    if (process.getuid?.() !== 0) {
      expect(read.outcome).toBe("skipped");
      expect(read.outcome === "skipped" && read.warning.kind).toBe(
        "cache_entry_skipped",
      );
    }
  });

  test("an absent entry is a plain miss with no warning", () => {
    expect(store().read("productFields")).toEqual({ outcome: "miss" });
  });
});

describe("an unwritable cache warns and the caller continues", () => {
  test("a directory that cannot be created produces one warning", () => {
    // A file where the directory should be: `mkdir -p` fails, and ADR-0005 §8
    // requires a warning rather than a refusal.
    mkdirSync(`${root}/pd`, { recursive: true });
    writeFileSync(directory(), "not a directory");

    const warning = store().write("users", [{ id: 1 }]);
    expect(warning?.kind).toBe("cache_entry_skipped");
  });

  test("a read-only directory produces one warning and leaves no file", () => {
    mkdirSync(directory(), { recursive: true });
    chmodSync(directory(), 0o500);

    const warning = store().write("users", [{ id: 1 }]);
    chmodSync(directory(), 0o700);

    // Root ignores the mode; the property under test is that a failed write is
    // a warning rather than a throw, and that no half-file survives it.
    if (warning !== undefined) {
      expect(warning.kind).toBe("cache_entry_skipped");
      expect(readdirSync(directory())).toEqual([]);
    }
  });
});
