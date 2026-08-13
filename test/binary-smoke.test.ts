import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBinary } from "../scripts/build.ts";

/**
 * Binary smoke — ADR-0019 §7 as amended by ADR-0021 §8.
 *
 * The version stamp only exists after the build substitutes `PD_VERSION`, so it
 * cannot be asserted in source form. Later tickets add the embedded `AGENTS.md`
 * and the manifest's `pd_version` agreement to this leg.
 */

const workspace = mkdtempSync(join(tmpdir(), "pd-binary-smoke-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const stamps = ["1.0.0", "1.0.0+g3f9a1c2", "1.0.0+g3f9a1c2.dirty"];

for (const stamp of stamps) {
  test(`pd --version prints the bare stamp ${stamp}`, async () => {
    const binary = await buildBinary({
      entry: new URL("../src/cli.ts", import.meta.url).pathname,
      outfile: join(workspace, `pd-${stamp.replace(/[+.]/g, "_")}`),
      version: stamp,
    });

    const run = Bun.spawnSync([binary, "--version"], { cwd: workspace });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`${stamp}\n`);
    expect(run.stderr.toString()).toBe("");
  });
}
