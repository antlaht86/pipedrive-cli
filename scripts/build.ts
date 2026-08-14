/**
 * The one build path — ADR-0021 §3.
 *
 * `bun run build` compiles `src/cli.ts` into `dist/pd` (`dist\pd.exe` on
 * Windows). Every build goes through `buildBinary` below, including the gate
 * test in `test/dotenv-autoload.test.ts`, so no supported build path can omit
 * the two autoload flags.
 *
 * `compile: { autoloadDotenv: false, autoloadBunfig: false }` is the documented
 * equivalent of the normative flags `--no-compile-autoload-dotenv` and
 * `--no-compile-autoload-bunfig`. They are a safety property, not an
 * optimisation: a compiled binary otherwise auto-loads `.env` from the process
 * CWD, and `PD_API_TOKEN` is tier 2 of the credential chain (ADR-0012 §3), so a
 * repository the agent happens to stand in could switch the Pipedrive account
 * from outside the chain.
 *
 * `minify` and `bytecode` are kept on measurement (research 07 §1.3): 21.5 ms
 * startup against 27.1 ms, for +2.9 MB on a ~63 MB binary.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stampVersion } from "../src/version.ts";

export type BuildBinaryOptions = {
  /** Entrypoint to compile. */
  entry: string;
  /** Output path, without a platform suffix. */
  outfile: string;
  /** Value stamped into the `PD_VERSION` define. */
  version: string;
};

/** Windows executables need the suffix; POSIX must not have it. */
export const executablePath = (outfile: string): string =>
  process.platform === "win32" ? `${outfile}.exe` : outfile;

export const buildBinary = async ({
  entry,
  outfile,
  version,
}: BuildBinaryOptions): Promise<string> => {
  const target = executablePath(outfile);

  const result = await Bun.build({
    entrypoints: [entry],
    format: "esm",
    minify: true,
    bytecode: true,
    define: {
      PD_VERSION: JSON.stringify(version),
      PD_DOCS: JSON.stringify(
        readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8"),
      ),
    },
    compile: {
      outfile: target,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });

  if (!result.success) {
    const detail = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`bun build failed:\n${detail}`);
  }

  return target;
};

/** Numeric semver comparison, enough for `Bun.version` against a floor. */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string): number[] =>
    v
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));

  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** `engines.bun` is a build-time floor, never a runtime error (ADR-0021 §2). */
export const enginesFloor = (engines: unknown): string | undefined => {
  if (typeof engines !== "object" || engines === null) return undefined;
  const declared = (engines as Record<string, unknown>)["bun"];
  if (typeof declared !== "string") return undefined;
  return declared.replace(/^[^\d]*/, "");
};

/**
 * The Bun floor is a build-time concern: a person building from source reads
 * build output, so this is a plain message and a non-zero exit, never a runtime
 * error variant (ADR-0021 §2, §7).
 */
export const bunVersionRefusal = (
  current: string,
  floor: string | undefined,
): string | undefined => {
  if (floor === undefined) return undefined;
  if (compareVersions(current, floor) >= 0) return undefined;
  return (
    `pd needs Bun ${floor} or newer to build. This is Bun ${current}.\n` +
    `Upgrade with: bun upgrade\n`
  );
};

const git = (args: string[]): string | undefined => {
  const run = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  if (run.exitCode !== 0) return undefined;
  return run.stdout.toString().trim();
};

/**
 * Reads the commit state of the checkout. A release tag is `v<version>` —
 * `v1.0.0` for `1.0.0`. Anything else counts as off a tag.
 */
export const gitStamp = (version: string): string => {
  const sha = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
  const tags = git(["tag", "--points-at", "HEAD"]) ?? "";
  const status = git(["status", "--porcelain"]) ?? "";

  return stampVersion({
    version,
    sha,
    atReleaseTag: tags.split("\n").includes(`v${version}`),
    dirty: status.length > 0,
  });
};

const main = async (): Promise<number> => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { version?: string; engines?: unknown };

  const refusal = bunVersionRefusal(Bun.version, enginesFloor(pkg.engines));
  if (refusal !== undefined) {
    process.stderr.write(refusal);
    return 1;
  }

  const version = gitStamp(pkg.version ?? "0.0.0");
  const outfile = await buildBinary({
    entry: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    outfile: "dist/pd",
    version,
  });

  process.stdout.write(`${outfile} ${version}\n`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
