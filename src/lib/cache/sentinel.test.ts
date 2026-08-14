/**
 * The sentinel's own properties, against a real temporary directory.
 *
 * `blocked-sentinel.test.ts` drives the refusal end to end through `route`.
 * These are the file's mechanics: the format, the mode bits, the expiry, and
 * the four ways a broken sentinel fails open (ADR-0010 §7 and its consequences).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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

import { blockedFromMemory, createSentinel } from "./sentinel.ts";
import {
  SENTINEL_FILE,
  SENTINEL_SCHEMA_VERSION,
  SENTINEL_TTL_SECONDS,
} from "./entries.ts";
import type { Clock } from "../pipedrive/clock.ts";

const TOKEN_HASH = "0123456789abcdef";
const TTL_MS = SENTINEL_TTL_SECONDS * 1000;

let root = "";
let time = 1_770_000_000_000;

const clock: Clock = {
  now: () => time,
  sleep: () => Promise.resolve(),
  random: () => 0,
};

const sentinel = (fingerprint = TOKEN_HASH) =>
  createSentinel({
    platform: "linux",
    env: { XDG_CACHE_HOME: root },
    home: "/home/nobody",
    fingerprint,
    clock,
  });

const directory = (fingerprint = TOKEN_HASH): string =>
  `${root}/pd/${fingerprint}`;

const path = (fingerprint = TOKEN_HASH): string =>
  `${directory(fingerprint)}/${SENTINEL_FILE}`;

const place = (body: string): void => {
  mkdirSync(directory(), { recursive: true });
  writeFileSync(path(), body);
};

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/pd-sentinel-`);
  time = 1_770_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the file it writes", () => {
  test("it lands under the credential's directory, at the reserved name", () => {
    sentinel().record();

    expect(existsSync(path())).toBe(true);
    expect(sentinel().path).toBe(path());
  });

  test("it carries a version and the moment of the block, and nothing else", () => {
    sentinel().record();

    expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({
      version: SENTINEL_SCHEMA_VERSION,
      blocked_at: time,
    });
  });

  test("it is 0600, because the directory name is derived from a credential", () => {
    sentinel().record();

    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  test("the temp file of the rename is not left behind", () => {
    sentinel().record();

    expect(readdirSync(directory())).toEqual([SENTINEL_FILE]);
  });

  test("a second block replaces the first, so the fresher one wins", () => {
    sentinel().record();
    time += 60_000;
    sentinel().record();

    expect(JSON.parse(readFileSync(path(), "utf8"))["blocked_at"]).toBe(time);
  });

  test("one credential's sentinel says nothing about another's", () => {
    sentinel().record();

    expect(sentinel("fedcba9876543210").remaining()).toBeUndefined();
  });

  test("a write that cannot happen is silent — the run is already ending", () => {
    // ADR-0010: the sentinel is defence in depth over the *next* invocation.
    // This one has already been told the truth, so an unwritable disk is not a
    // second failure to report.
    mkdirSync(directory(), { recursive: true });
    chmodSync(directory(), 0o500);

    expect(() => sentinel().record()).not.toThrow();
    expect(sentinel().remaining()).toBeUndefined();

    chmodSync(directory(), 0o700);
  });
});

describe("how long it lives", () => {
  test("a fresh block has the full fifteen minutes left", () => {
    sentinel().record();

    expect(sentinel().remaining()).toBe(SENTINEL_TTL_SECONDS);
  });

  test("the remaining life falls as the clock moves", () => {
    sentinel().record();
    time += 5 * 60_000;

    expect(sentinel().remaining()).toBe(SENTINEL_TTL_SECONDS - 5 * 60);
  });

  test("one millisecond short of the expiry it is still live", () => {
    sentinel().record();
    time += TTL_MS - 1;

    // Never zero while live: the bound is exclusive, so the refusal cannot
    // promise to try again "in 0 minutes".
    expect(sentinel().remaining()).toBe(1);
  });

  test("at the expiry exactly it is gone", () => {
    sentinel().record();
    time += TTL_MS;

    expect(sentinel().remaining()).toBeUndefined();
  });

  test("past the expiry it is gone, and the file goes with it", () => {
    sentinel().record();
    time += TTL_MS + 1;

    expect(sentinel().remaining()).toBeUndefined();
    // ADR-0010 §7 names two removers: the expiry and a human. Nothing else
    // visits this file, so the expiry has to delete it here — otherwise `pd
    // cache info` would report a block that stopped nothing.
    expect(existsSync(path())).toBe(false);
  });

  test("reading it does not push the expiry forward", () => {
    // The one property that makes fifteen minutes a bound rather than a wish:
    // an agent looping `pd` must not renew the block by meeting it.
    const blockedAt = time;
    sentinel().record();
    for (let i = 0; i < 50; i += 1) {
      time += 10_000;
      sentinel().remaining();
    }

    // Fifty meetings later the life left is still measured from the block.
    expect(sentinel().remaining()).toBe(SENTINEL_TTL_SECONDS - 500);
    time = blockedAt + TTL_MS + 1;
    expect(sentinel().remaining()).toBeUndefined();
    expect(existsSync(path())).toBe(false);
  });

  test("a clock that went backwards expires it rather than blocking forever", () => {
    sentinel().record();
    time -= 60_000;

    expect(sentinel().remaining()).toBeUndefined();
  });
});

describe("a broken sentinel fails open, and stays on disk", () => {
  test("no file at all is no block", () => {
    expect(sentinel().remaining()).toBeUndefined();
  });

  test("a file that is not JSON", () => {
    place("{ this is not json");

    expect(sentinel().remaining()).toBeUndefined();
    expect(existsSync(path())).toBe(true);
  });

  test("a file that is JSON but not a sentinel", () => {
    place(JSON.stringify({ at: time }));

    expect(sentinel().remaining()).toBeUndefined();
  });

  test("a version this binary does not recognise", () => {
    place(
      JSON.stringify({ version: SENTINEL_SCHEMA_VERSION + 1, blocked_at: time }),
    );

    expect(sentinel().remaining()).toBeUndefined();
  });

  test("a file that cannot be read at all", () => {
    place(JSON.stringify({ version: SENTINEL_SCHEMA_VERSION, blocked_at: time }));
    chmodSync(path(), 0o000);

    expect(sentinel().remaining()).toBeUndefined();

    chmodSync(path(), 0o600);
  });
});

describe("the refusal it produces", () => {
  test("it is ADR-0001's blocked variant, not a variant of its own", () => {
    const error = blockedFromMemory(600, path());

    expect(error.code).toBe("blocked");
    expect(error.exit_code).toBe(3);
    expect(error.retry).toBe("not_today");
  });

  test("it carries no countdown, because not_today has nothing to count to", () => {
    expect(blockedFromMemory(600, path()).retry_after_seconds).toBeUndefined();
  });

  test("details record that the block came from memory", () => {
    // ADR-0010 §6: `details` says the block came from memory rather than from a
    // fresh response, and per ADR-0001 nothing in `details` may be branched on.
    expect(blockedFromMemory(600, path()).details).toEqual({
      source: "sentinel",
      remaining_seconds: 600,
      sentinel: path(),
    });
  });

  test("the message names the file, so a human can remove it", () => {
    // ADR-0010 §7 makes a human one of the two things that removes the
    // sentinel, and a human cannot remove what the refusal does not name.
    expect(blockedFromMemory(600, path()).message).toContain(path());
  });

  test("the message says no request was made, which is the surprising part", () => {
    expect(blockedFromMemory(600, path()).message).toContain("no request");
  });
});
