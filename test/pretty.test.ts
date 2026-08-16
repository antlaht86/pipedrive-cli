import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { route } from "../src/router.ts";
import { fingerprintOf } from "../src/lib/auth/credentials.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { deal } from "./support/deals.ts";
import { usersFixture, user } from "./support/cached.ts";
import { LIVE, listPage } from "./support/records.ts";

const workspace = mkdtempSync(join(tmpdir(), "pd-pretty-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const run = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[],
	options: { home?: string; token?: string } = {},
) => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const home = options.home ?? workspace;
	const token = options.token ?? "pretty-token";
	const exit = await route({
		argv,
		platform: "linux",
		env: { PD_API_TOKEN: token, XDG_CACHE_HOME: join(home, "cache") },
		home,
		...(fixtures === undefined
			? {}
			: { transport: createReplayTransport(fixtures) }),
		sink: (text) => stdout.push(text),
		stderr: (text) => stderr.push(text),
		isTty: () => false,
	});
	return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
};

describe("--pretty data output", () => {
	test("buffers records into an aligned non-JSON table in selector order", async () => {
		const title = "A title much wider than its heading";
		const result = await run(
			[listPage(LIVE[0]!, [deal(1, { title, value: 7 })], null)],
			["deals", "list", "--pretty", "--fields", "value,id,title"],
		);

		expect(result.exit).toBe(0);
		expect(result.stdout).not.toContain("{");
		expect(result.stdout).not.toContain('"');
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]?.trim().split(/\s+/)).toEqual(["value", "id", "title"]);
		expect(lines[1]).toContain(title);
		expect(lines[0]?.indexOf("title")).toBe(lines[1]?.indexOf(title));
	});

	test("keeps API-supplied search name fields when selected directly", async () => {
		const fixture: Fixture = {
			path: "/api/v2/deals/search",
			query: { limit: 500, term: "Acme" },
			body: {
				success: true,
				data: {
					items: [
						{
							result_score: 0.98,
							item: {
								id: 1,
								type: "deal",
								title: "Acme renewal",
								value: 1200,
								currency: "EUR",
								status: "open",
								visible_to: 3,
								person: { id: 31, name: "Aino" },
								organization: { id: 41, name: "Acme" },
								owner: { id: 11 },
								stage: { id: 21, name: "Qualified" },
								custom_fields: ["Acme Oy"],
								notes: ["Asked for renewal"],
								is_archived: false,
							},
						},
					],
				},
				additional_data: { next_cursor: null },
			},
		};
		const result = await run(
			[fixture],
			["deals", "search", "Acme", "--pretty", "--fields", "person_name"],
		);

		expect(result.exit).toBe(0);
		expect(result.stdout).toContain("person_name");
		expect(result.stdout).toContain("Aino");
		expect(result.stdout).not.toContain("{");
	});

	test("a usage error with --pretty has only the stderr line", async () => {
		const result = await run(undefined, [
			"deals",
			"list",
			"--pretty",
			"--unknown",
		]);

		expect(result.exit).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("pd:");
	});

	test("a failed walk prints fetched rows but no machine error object", async () => {
		const first = listPage(LIVE[0]!, [deal(1)], "next");
		const broken: Fixture = {
			path: LIVE[0]!.path,
			query: { limit: 500, cursor: "next" },
			body: { success: true, data: "not-an-array" },
		};
		const result = await run(
			[first, broken],
			["deals", "list", "--pretty", "--fields", "title"],
		);

		expect(result.exit).toBe(1);
		expect(result.stdout).toContain("Acme Oy");
		expect(result.stdout).not.toContain("invalid_response");
		expect(result.stdout).not.toContain("{");
		expect(result.stderr).toContain("pd:");
	});

	test("cache_entry_skipped is human prose on stderr, never stdout", async () => {
		const home = join(workspace, "corrupt-cache");
		const token = "corrupt-pretty-token";
		const directory = join(home, "cache", "pd", fingerprintOf(token));
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "users.json"), "{ broken");

		const result = await run(
			[usersFixture([user(11)])],
			["users", "list", "--pretty", "--fields", "name"],
			{ home, token },
		);

		expect(result.exit).toBe(0);
		expect(result.stdout).toContain("Aino Virtanen 11");
		expect(result.stdout).not.toContain("cache_entry_skipped");
		expect(result.stderr).toContain("cached users entry");
	});
});

describe("--pretty single-object output", () => {
	test("auth status renders every status field as human text", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const home = join(workspace, "auth-home");
		mkdirSync(home, { recursive: true });
		const result = Bun.spawnSync(["bun", cli, "auth", "status", "--pretty"], {
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_CACHE_HOME: join(home, "cache"),
				PD_API_TOKEN: "auth-pretty-token",
			},
			cwd: workspace,
		});
		const stdout = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(stdout).not.toContain("{");
		for (const field of [
			"found",
			"tier",
			"path",
			"fingerprint",
			"cache_dir_exists",
			"credential_is_write_capable",
			"warnings",
		]) {
			expect(stdout).toContain(field);
		}
	});

	test("cache info renders its single object as human text", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const home = join(workspace, "cache-home");
		mkdirSync(home, { recursive: true });
		const result = Bun.spawnSync(["bun", cli, "cache", "info", "--pretty"], {
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: home,
				XDG_CACHE_HOME: join(home, "cache"),
			},
			cwd: workspace,
		});
		const stdout = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(stdout).toContain("path");
		expect(stdout).toContain("entries");
		expect(stdout).toContain("blocked");
		expect(stdout).not.toContain("{");
	});

	test("an auth usage error has only the stderr line", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = Bun.spawnSync([
			"bun",
			cli,
			"auth",
			"status",
			"--pretty",
			"--unknown",
		]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("pd:");
	});
});
