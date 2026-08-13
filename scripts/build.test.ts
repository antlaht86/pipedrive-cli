import { describe, expect, test } from "bun:test";

import {
  bunVersionRefusal,
  compareVersions,
  enginesFloor,
  executablePath,
} from "./build.ts";

describe("enginesFloor", () => {
  test("strips the range prefix from engines.bun", () => {
    expect(enginesFloor({ bun: ">=1.3.14" })).toBe("1.3.14");
    expect(enginesFloor({ bun: "1.3.14" })).toBe("1.3.14");
  });

  test("is undefined when no floor is declared", () => {
    expect(enginesFloor(undefined)).toBeUndefined();
    expect(enginesFloor({})).toBeUndefined();
    expect(enginesFloor({ node: ">=20" })).toBeUndefined();
  });
});

describe("compareVersions", () => {
  test("orders by major, minor then patch", () => {
    expect(compareVersions("1.3.14", "1.3.14")).toBe(0);
    expect(compareVersions("1.3.15", "1.3.14")).toBeGreaterThan(0);
    expect(compareVersions("1.2.99", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("bunVersionRefusal", () => {
  test("refuses below the floor with a readable message", () => {
    const message = bunVersionRefusal("1.2.0", "1.3.14");
    expect(message).toContain("pd needs Bun 1.3.14 or newer to build");
    expect(message).toContain("This is Bun 1.2.0");
  });

  test("passes at or above the floor", () => {
    expect(bunVersionRefusal("1.3.14", "1.3.14")).toBeUndefined();
    expect(bunVersionRefusal("1.4.0", "1.3.14")).toBeUndefined();
  });

  test("passes when no floor is declared", () => {
    expect(bunVersionRefusal("0.1.0", undefined)).toBeUndefined();
  });
});

describe("executablePath", () => {
  test("matches the platform", () => {
    const expected =
      process.platform === "win32" ? "dist/pd.exe" : "dist/pd";
    expect(executablePath("dist/pd")).toBe(expected);
  });
});
