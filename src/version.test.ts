import { describe, expect, test } from "bun:test";

import { stampVersion } from "./version.ts";

describe("stampVersion", () => {
  test("a clean checkout at a release tag prints the bare version", () => {
    expect(
      stampVersion({
        version: "1.0.0",
        sha: "3f9a1c2",
        atReleaseTag: true,
        dirty: false,
      }),
    ).toBe("1.0.0");
  });

  test("a clean checkout off a tag names the commit", () => {
    expect(
      stampVersion({
        version: "1.0.0",
        sha: "3f9a1c2",
        atReleaseTag: false,
        dirty: false,
      }),
    ).toBe("1.0.0+g3f9a1c2");
  });

  test("uncommitted changes add the dirty marker", () => {
    expect(
      stampVersion({
        version: "1.0.0",
        sha: "3f9a1c2",
        atReleaseTag: false,
        dirty: true,
      }),
    ).toBe("1.0.0+g3f9a1c2.dirty");
  });

  test("a dirty tree at a release tag is still dirty", () => {
    expect(
      stampVersion({
        version: "1.0.0",
        sha: "3f9a1c2",
        atReleaseTag: true,
        dirty: true,
      }),
    ).toBe("1.0.0+g3f9a1c2.dirty");
  });
});
