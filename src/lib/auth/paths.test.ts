import { describe, expect, test } from "bun:test";

import { cacheDirFor, configDir, credentialsPath } from "./paths.ts";

/**
 * ADR-0021 §8 keeps ADR-0014 §6's mapping. Both platforms are asserted from
 * every machine, because `platform` is a parameter rather than a read of
 * `process.platform` — the Windows leg of CI exercises the same code with the
 * real value, and this exercises it everywhere.
 */

const posix = { platform: "linux" as const, home: "/home/ada" };
const windows = { platform: "win32" as const, home: "C:\\Users\\Ada" };

describe("the config directory", () => {
  test("defaults to ~/.config/pd on POSIX", () => {
    expect(configDir({ ...posix, env: {} })).toBe("/home/ada/.config/pd");
  });

  test("honours XDG_CONFIG_HOME on POSIX", () => {
    expect(configDir({ ...posix, env: { XDG_CONFIG_HOME: "/xdg/cfg" } })).toBe(
      "/xdg/cfg/pd",
    );
  });

  // ADR-0022 §2: an empty or whitespace-only variable is unset.
  test.each(["", "   "])("ignores XDG_CONFIG_HOME set to %p", (value) => {
    expect(configDir({ ...posix, env: { XDG_CONFIG_HOME: value } })).toBe(
      "/home/ada/.config/pd",
    );
  });

  test("keeps a trailing space in a directory name the operator did name", () => {
    expect(configDir({ ...posix, env: { XDG_CONFIG_HOME: "/xdg/cfg " } })).toBe(
      "/xdg/cfg /pd",
    );
  });

  test("is %APPDATA%\\pd on Windows", () => {
    expect(
      configDir({ ...windows, env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" } }),
    ).toBe("C:\\Users\\Ada\\AppData\\Roaming\\pd");
  });

  test("falls back to the Windows default when APPDATA is unset", () => {
    expect(configDir({ ...windows, env: {} })).toBe(
      "C:\\Users\\Ada\\AppData\\Roaming\\pd",
    );
  });

  test("does not read XDG_CONFIG_HOME on Windows", () => {
    expect(configDir({ ...windows, env: { XDG_CONFIG_HOME: "/xdg/cfg" } })).toBe(
      "C:\\Users\\Ada\\AppData\\Roaming\\pd",
    );
  });
});

describe("the credentials file", () => {
  test("is the `credentials` file in the config directory", () => {
    expect(credentialsPath({ ...posix, env: {} })).toBe(
      "/home/ada/.config/pd/credentials",
    );
  });

  test("uses a backslash on Windows", () => {
    expect(credentialsPath({ ...windows, env: {} })).toBe(
      "C:\\Users\\Ada\\AppData\\Roaming\\pd\\credentials",
    );
  });
});

describe("the cache directory", () => {
  const fingerprint = "0123456789abcdef";

  test("defaults to ~/.cache/pd/<fingerprint> on POSIX", () => {
    expect(cacheDirFor({ ...posix, env: {}, fingerprint })).toBe(
      "/home/ada/.cache/pd/0123456789abcdef",
    );
  });

  test("honours XDG_CACHE_HOME on POSIX", () => {
    expect(
      cacheDirFor({ ...posix, env: { XDG_CACHE_HOME: "/xdg/cache" }, fingerprint }),
    ).toBe("/xdg/cache/pd/0123456789abcdef");
  });

  test("is %LOCALAPPDATA%\\pd\\<fingerprint> on Windows", () => {
    expect(
      cacheDirFor({
        ...windows,
        env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        fingerprint,
      }),
    ).toBe("C:\\Users\\Ada\\AppData\\Local\\pd\\0123456789abcdef");
  });

  test("falls back to the Windows default when LOCALAPPDATA is unset", () => {
    expect(cacheDirFor({ ...windows, env: {}, fingerprint })).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\pd\\0123456789abcdef",
    );
  });
});
