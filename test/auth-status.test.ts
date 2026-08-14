import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pd auth status` end to end — ADR-0012 §5.
 *
 * The unit tests cover the resolution chain; this covers the process contract:
 * one JSON object on stdout, exit 0 even with nothing found, and the exit codes
 * of the two refusals.
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "pd-auth-cli-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

let seq = 0;

/** A home with nothing in it, so the developer's own credentials are unreachable. */
const isolated = (): { home: string; env: Record<string, string> } => {
	seq += 1;
	const home = join(workspace, `home-${seq}`);
	mkdirSync(join(home, "config", "pd"), { recursive: true });
	return {
		home,
		env: {
			PATH: process.env["PATH"] ?? "",
			HOME: home,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
		},
	};
};

type Run = { exitCode: number; stdout: string; stderr: string };

const run = (args: string[], env: Record<string, string>): Run => {
	const result = Bun.spawnSync(["bun", cli, ...args], { env, cwd: workspace });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
};

const parse = (stdout: string): Record<string, unknown> => {
	const lines = stdout.trimEnd().split("\n");
	// One JSON object, not an NDJSON stream — ADR-0012 §5.
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] as string) as Record<string, unknown>;
};

describe("with no credential", () => {
	test("exits 0 and reports the absence", () => {
		const { env } = isolated();
		const result = run(["auth", "status"], env);

		expect(result.exitCode).toBe(0);
		expect(parse(result.stdout)["found"]).toBe(false);
	});
});

describe("with PD_API_TOKEN set", () => {
	test("reports the env tier and a 16-character fingerprint", () => {
		const { env } = isolated();
		const result = run(["auth", "status"], { ...env, PD_API_TOKEN: "a-token" });
		const status = parse(result.stdout);

		expect(result.exitCode).toBe(0);
		expect(status["tier"]).toBe("env");
		expect(status["fingerprint"]).toHaveLength(16);
		expect(status["credential_is_write_capable"]).toBe(true);
	});

	test("prints nothing on stderr", () => {
		const { env } = isolated();
		expect(
			run(["auth", "status"], { ...env, PD_API_TOKEN: "a-token" }).stderr,
		).toBe("");
	});

	test("never prints the token", () => {
		const { env } = isolated();
		const result = run(["auth", "status"], { ...env, PD_API_TOKEN: "a-token" });

		expect(result.stdout).not.toContain("a-token");
	});
});

describe("with a credentials file", () => {
	test("warns about loose permissions and still exits 0", () => {
		const { env, home } = isolated();
		const path = join(home, "config", "pd", "credentials");
		writeFileSync(path, "a-token\n");
		chmodSync(path, 0o644);

		const result = run(["auth", "status"], env);
		const status = parse(result.stdout);
		const warnings = status["warnings"] as { kind: string }[];

		expect(result.exitCode).toBe(0);
		expect(status["tier"]).toBe("config-file");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.kind).toBe("credential_file_permissions");
	});
});

describe("the refusals", () => {
	test("--token is refused in any form, exit 2", () => {
		const { env } = isolated();

		for (const arg of ["--token", "--token=secret"]) {
			const result = run(["auth", "status", arg, "secret"], env);
			expect(result.exitCode).toBe(2);
			expect(parse(result.stdout)["code"]).toBe("usage");
		}
	});

	test("auth flags are validated by the command-table parser", () => {
		const { env } = isolated();
		const missingPath = run(["auth", "status", "--token-file="], env);
		const unknown = run(["auth", "status", "--unknown"], env);

		expect(missingPath.exitCode).toBe(2);
		expect(parse(missingPath.stdout)["message"]).toBe(
			"--token-file needs a path.",
		);
		expect(unknown.exitCode).toBe(2);
		expect(parse(unknown.stdout)["message"]).toContain(
			"It takes --token-file and no other flag.",
		);
	});

	test("a --token-file that holds no token is usage, exit 2", () => {
		const { env } = isolated();
		const result = run(
			["auth", "status", "--token-file", join(workspace, "nope")],
			env,
		);

		expect(result.exitCode).toBe(2);
		const error = parse(result.stdout);
		expect(error["code"]).toBe("usage");
		expect(error["exit_code"]).toBe(2);
		expect(error["retry"]).toBe("never");
		expect(result.stderr).toContain("pd:");
	});

	test("--token-file overrides PD_API_TOKEN rather than losing to it", () => {
		const { env } = isolated();
		const path = join(workspace, `explicit-${seq}`);
		writeFileSync(path, "from-flag\n");
		chmodSync(path, 0o600);

		const result = run(["auth", "status", "--token-file", path], {
			...env,
			PD_API_TOKEN: "from-env",
		});

		expect(parse(result.stdout)["tier"]).toBe("token-file");
	});
});
