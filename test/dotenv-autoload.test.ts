import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBinary } from "../scripts/build.ts";

/**
 * CI gate — ADR-0021 §3, ADR-0019 §8.
 *
 * A compiled Bun binary auto-loads `.env` from the process CWD by default.
 * `pd`'s consumer is an agent that `cd`s into arbitrary repositories, and
 * `PD_API_TOKEN` is tier 2 of the credential chain, so an autoloaded `.env`
 * would be a silent account switch. The build disables the autoload; this
 * asserts it against a real compiled binary rather than against the source.
 *
 * Ticket 03 extends this gate to `pd auth status` on `dist/pd`, asserting the
 * run does not report the `env` tier.
 */

const workspace = mkdtempSync(join(tmpdir(), "pd-dotenv-gate-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

test("the built binary ignores a .env and a bunfig.toml in the process CWD", async () => {
  const probe = await buildBinary({
    entry: fileURLToPath(new URL("./fixtures/env-probe.ts", import.meta.url)),
    outfile: join(workspace, "probe"),
    version: "0.0.0-probe",
  });

  const cwd = mkdtempSync(join(workspace, "cwd-"));
  await Bun.write(join(cwd, ".env"), "PD_API_TOKEN=leaked-from-dotenv\n");
  await Bun.write(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await Bun.write(
    join(cwd, "preload.ts"),
    'process.env.PD_BUNFIG_PRELOAD = "leaked-from-bunfig";\n',
  );

  const run = Bun.spawnSync([probe], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
  });

  expect(run.exitCode).toBe(0);
  // First field is the `.env` half, second the `bunfig.toml` half.
  expect(run.stdout.toString().trim()).toBe("unset unset");
});
