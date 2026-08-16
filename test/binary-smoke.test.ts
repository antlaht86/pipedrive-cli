import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Result } from "neverthrow";

import { buildBinaryRetrying as buildBinary } from "./support/build.ts";

/**
 * Binary smoke — ADR-0019 §7 as amended by ADR-0021 §8.
 *
 * Version stamps and embedded documentation only exist after the build, so they
 * cannot be asserted in source form. This leg checks the artifact itself.
 */

const workspace = mkdtempSync(join(tmpdir(), "pd-binary-smoke-"));
const parseJson = Result.fromThrowable(JSON.parse);
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const stamps = ["1.0.0", "1.0.0+g3f9a1c2", "1.0.0+g3f9a1c2.dirty"];

for (const stamp of stamps) {
	test(`the built pd reports one version in --version and its manifest: ${stamp}`, async () => {
		const binary = await buildBinary({
			entry: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			outfile: join(workspace, `pd-${stamp.replace(/[+.]/g, "_")}`),
			version: stamp,
		});

		const run = Bun.spawnSync([binary, "--version"], { cwd: workspace });
		const manifestRun = Bun.spawnSync([binary, "manifest"], { cwd: workspace });
		const parsed = parseJson(manifestRun.stdout.toString());
		const manifest =
			parsed.isOk() && typeof parsed.value === "object" && parsed.value !== null
				? (parsed.value as { pd_version?: string })
				: {};

		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toBe(`${stamp}\n`);
		expect(run.stderr.toString()).toBe("");
		expect(manifestRun.exitCode).toBe(0);
		expect(manifestRun.stderr.toString()).toBe("");
		expect(parsed.isOk()).toBe(true);
		expect(manifest.pd_version).toBe(stamp);
	});
}

test("the built pd carries its exact AGENTS.md when copied away from the checkout", async () => {
	const binary = await buildBinary({
		entry: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
		outfile: join(workspace, "pd-docs-source"),
		version: "1.0.0",
	});
	const unrelated = mkdtempSync(join(tmpdir(), "pd-docs-unrelated-"));
	const copied = join(
		unrelated,
		process.platform === "win32" ? "renamed-pd.exe" : "renamed-pd",
	);
	copyFileSync(binary, copied);

	const run = Bun.spawnSync([copied, "docs"], { cwd: unrelated });
	const refusal = Bun.spawnSync([copied, "docs", "--fields", "x"], {
		cwd: unrelated,
	});

	expect(run.exitCode).toBe(0);
	expect(Buffer.from(run.stdout).equals(readFileSync("AGENTS.md"))).toBe(true);
	expect(run.stderr.toString()).toBe("");
	expect(refusal.exitCode).toBe(2);
	const refusalLine = parseJson(refusal.stdout.toString());
	expect(refusalLine.isOk()).toBe(true);
	expect(refusalLine.unwrapOr({})).toMatchObject({
		type: "error",
		code: "usage",
	});

	rmSync(unrelated, { recursive: true, force: true });
});
