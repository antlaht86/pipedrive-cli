/**
 * The format-drift gate — ADR-0002.
 *
 * "Nothing validates output at runtime. Line shapes are TypeScript types. The
 * prototype sample files are the normative examples and the only guard against
 * drift." This test is what makes that last clause true: the sample generator
 * drives the shipped `NdjsonWriter`, and the committed files must equal what it
 * produces, byte for byte.
 *
 * A failure here is one of two things and never a third: the writer changed by
 * accident, or the format changed on purpose and the samples were not
 * regenerated in the same commit.
 *
 *     bun run .scratch/pd-cli-design/prototypes/10-output-format/generate.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ARRAY_CASES,
  CASES,
} from "../.scratch/pd-cli-design/prototypes/10-output-format/generate.ts";

const SAMPLES = join(
  import.meta.dir,
  "..",
  ".scratch",
  "pd-cli-design",
  "prototypes",
  "10-output-format",
  "samples",
);

describe("the normative NDJSON samples", () => {
  for (const { name, ndjson } of CASES) {
    test(`${name} matches the writer's output byte for byte`, () => {
      expect(readFileSync(join(SAMPLES, name), "utf8")).toBe(ndjson);
    });
  }

  test("every sample's last line carries complete and emitted", () => {
    for (const { name, ndjson } of CASES) {
      const lines = ndjson.split("\n").filter((line) => line !== "");
      const last = JSON.parse(lines[lines.length - 1] as string) as Record<
        string,
        unknown
      >;
      expect({ name, complete: typeof last["complete"] }).toEqual({
        name,
        complete: "boolean",
      });
      expect({ name, emitted: typeof last["emitted"] }).toEqual({
        name,
        emitted: "number",
      });
    }
  });

  test("every sample carries exactly one trailer, and it is last", () => {
    for (const { name, ndjson } of CASES) {
      const types = ndjson
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { type: string }).type);
      const trailers = types.filter(
        (type) => type === "summary" || type === "error",
      );
      expect({ name, trailers: trailers.length }).toEqual({ name, trailers: 1 });
      expect({ name, last: types[types.length - 1] }).toEqual({
        name,
        last: trailers[0] as string,
      });
    }
  });
});

describe("the rejected envelope candidate is kept as it was argued against", () => {
  for (const { name, body } of ARRAY_CASES) {
    test(`${name} is unchanged`, () => {
      expect(readFileSync(join(SAMPLES, name), "utf8")).toBe(body);
    });
  }
});
