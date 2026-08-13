import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintOf } from "./credentials.ts";
import { authStatus } from "./status.ts";

/**
 * ADR-0012 §5 — `pd auth status` describes the configuration rather than using
 * it. Zero requests, zero writes, and finding nothing exits 0.
 */

const workspace = mkdtempSync(join(tmpdir(), "pd-auth-status-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

let seq = 0;
let configHome: string;
let cacheHome: string;
let credentials: string;

const posix = () => ({
  platform: "linux" as const,
  home: join(workspace, "home"),
  env: { XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome },
});

beforeEach(() => {
  seq += 1;
  configHome = join(workspace, `cfg-${seq}`);
  cacheHome = join(workspace, `cache-${seq}`);
  mkdirSync(join(configHome, "pd"), { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  credentials = join(configHome, "pd", "credentials");
});

const writeToken = (token: string, mode = 0o600): void => {
  writeFileSync(credentials, token);
  chmodSync(credentials, mode);
};

describe("with no credential anywhere", () => {
  test("reports the absence rather than failing", () => {
    const status = authStatus(posix())._unsafeUnwrap();
    expect(status.found).toBe(false);
  });

  test("omits tier, path and fingerprint rather than nulling them", () => {
    const status = authStatus(posix())._unsafeUnwrap();
    expect(Object.keys(status)).not.toContain("tier");
    expect(Object.keys(status)).not.toContain("path");
    expect(Object.keys(status)).not.toContain("fingerprint");
  });

  test("still carries the always-present fields", () => {
    const status = authStatus(posix())._unsafeUnwrap();
    expect(status.cache_dir_exists).toBe(false);
    expect(status.credential_is_write_capable).toBe(false);
    expect(status.warnings).toEqual([]);
  });
});

describe("with a credential", () => {
  test("names the tier and the file path", () => {
    writeToken("a-token");
    const status = authStatus(posix())._unsafeUnwrap();

    expect(status.found).toBe(true);
    expect(status.tier).toBe("config-file");
    expect(status.path).toBe(credentials);
  });

  test("reports the fingerprint the cache directory uses", () => {
    writeToken("a-token");
    expect(authStatus(posix())._unsafeUnwrap().fingerprint).toBe(
      fingerprintOf("a-token"),
    );
  });

  test("never prints the token", () => {
    writeToken("a-token");
    expect(JSON.stringify(authStatus(posix())._unsafeUnwrap())).not.toContain(
      "a-token",
    );
  });

  test("states the token is write-capable, every run", () => {
    writeToken("a-token");
    expect(authStatus(posix())._unsafeUnwrap().credential_is_write_capable).toBe(
      true,
    );
  });

  test("omits path for the env tier, which has no file", () => {
    const status = authStatus({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "from-env" },
    })._unsafeUnwrap();

    expect(status.tier).toBe("env");
    expect(Object.keys(status)).not.toContain("path");
  });
});

describe("the cache directory", () => {
  test("is reported absent when it does not exist", () => {
    writeToken("a-token");
    expect(authStatus(posix())._unsafeUnwrap().cache_dir_exists).toBe(false);
  });

  test("is reported present when it exists for this fingerprint", () => {
    writeToken("a-token");
    mkdirSync(join(cacheHome, "pd", fingerprintOf("a-token")), {
      recursive: true,
    });

    expect(authStatus(posix())._unsafeUnwrap().cache_dir_exists).toBe(true);
  });

  test("is keyed by the credential, so a different token misses", () => {
    writeToken("a-token");
    mkdirSync(join(cacheHome, "pd", fingerprintOf("another-token")), {
      recursive: true,
    });

    expect(authStatus(posix())._unsafeUnwrap().cache_dir_exists).toBe(false);
  });
});

describe("warnings", () => {
  test("carry the loose-permission warning of the resolver", () => {
    writeToken("a-token", 0o644);
    const status = authStatus(posix())._unsafeUnwrap();

    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]?.kind).toBe("credential_file_permissions");
  });

  test("state the NTFS gap on Windows for a file tier", () => {
    const status = authStatus({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      readFile: () => ({ text: "a-token", mode: 0o600 }),
      dirExists: () => false,
    })._unsafeUnwrap();

    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]?.kind).toBe("credential_file_permissions");
    expect(status.warnings[0]?.message).toContain("NTFS");
  });

  test("do not state the NTFS gap for the env tier, which has no file", () => {
    const status = authStatus({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", PD_API_TOKEN: "x" },
      dirExists: () => false,
    })._unsafeUnwrap();

    expect(status.warnings).toEqual([]);
  });
});

describe("a bad --token-file", () => {
  test("is an error rather than a status object", () => {
    const error = authStatus({
      ...posix(),
      tokenFile: join(workspace, "nope"),
    })._unsafeUnwrapErr();

    expect(error.code).toBe("usage");
  });
});

describe("the zero-cost promise", () => {
  test("makes no HTTP request", () => {
    writeToken("a-token");
    const original = globalThis.fetch;
    // Ticket 04 replaces this with the dispatch count of `guardedFetch`, which
    // is the spec's single answer to every "and no request was made" assertion.
    // Until that seam exists, a throwing global `fetch` is the honest form.
    globalThis.fetch = (() => {
      throw new Error("pd auth status made an HTTP request");
    }) as unknown as typeof fetch;

    try {
      expect(authStatus(posix())._unsafeUnwrap().found).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("writes nothing under the config or cache directories", () => {
    writeToken("a-token");
    const before = tree();
    authStatus(posix())._unsafeUnwrap();
    expect(tree()).toEqual(before);
  });
});

/** Every path under the two per-user directories, sorted. */
const tree = (): string[] =>
  [configHome, cacheHome]
    .flatMap((root) => Array.from(new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: false })).map((p) => join(root, p)))
    .sort();
