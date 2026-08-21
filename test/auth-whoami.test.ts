/**
 * `pd auth whoami` end to end — ticket 30's acceptance criteria, ADR-0033.
 *
 * The command is driven directly rather than through `route()`, because ADR-0009
 * §8 puts the `auth` subtree outside the resource grammar and `cli.ts` dispatches
 * it. Everything below that entry point — the prologue, the gate, the writer, the
 * error union and the exit codes — is the real thing, against fixture replay
 * (ADR-0019 §2). The default transport throws, so a request a test forgot to
 * record fails the run rather than reaching Pipedrive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { createManifest } from "../src/command-table.ts";
import { whoamiCommand } from "../src/commands/whoami.ts";
import { authStatus } from "../src/lib/auth/status.ts";
import type { Transport } from "../src/lib/pipedrive/guarded-fetch.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { FakeClock } from "./support/clock.ts";

const ME_PATH = "/v1/users/me";

/** One `access` array, shaped as the v1 spec declares it. */
const ACCESS = [
	{ app: "global", admin: true, permission_set_id: "abc" },
	{ app: "sales", admin: false, permission_set_id: "def" },
];

/**
 * A `/users/me` body. `access` is opt-in per test, because whether it arrives at
 * all is what decides the two derived admin fields (ADR-0033 §4).
 */
const meBody = (overrides: Record<string, unknown> = {}): unknown => ({
	success: true,
	data: {
		id: 14182285,
		name: "antti lahtinen",
		default_currency: "EUR",
		locale: "fi_FI",
		lang: 1,
		email: "antti@example.com",
		phone: null,
		activated: true,
		last_login: "2026-08-20 09:00:00",
		created: "2019-01-01 09:00:00",
		modified: null,
		has_created_company: true,
		active_flag: true,
		timezone_name: "Europe/Helsinki",
		timezone_offset: "+03:00",
		role_id: 1,
		icon_url: null,
		is_you: true,
		is_deleted: false,
		company_id: 1234567,
		company_name: "Zimple",
		company_domain: "zimple",
		...overrides,
	},
});

const okFixture = (body: unknown = meBody()): Fixture => ({
	path: ME_PATH,
	body,
});

type Run = {
	exit: number;
	stdout: string;
	lines: Line[];
	stderr: string[];
	last: Line;
	record: Line | undefined;
};

/** Fresh per test, so a sentinel one test writes cannot refuse the next. */
let cacheHome = "";

beforeEach(() => {
	cacheHome = mkdtempSync(`${tmpdir()}/pd-whoami-`);
});

afterEach(() => {
	rmSync(cacheHome, { recursive: true, force: true });
});

const runWith = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[] = [],
	env: Record<string, string | undefined> = { PD_API_TOKEN: "a-token" },
	transport?: Transport,
): Promise<Run> => {
	const out = capture();
	const exit = await whoamiCommand({
		argv,
		platform: "linux",
		env: { ...env, XDG_CACHE_HOME: cacheHome },
		home: "/home/nobody",
		clock: new FakeClock(),
		...(transport !== undefined
			? { transport }
			: fixtures === undefined
				? {}
				: { transport: createReplayTransport(fixtures) }),
		sink: out.sink,
		stderr: out.stderr,
	});
	// `--pretty` is not NDJSON, so the parse is skipped rather than attempted.
	const lines = argv.includes("--pretty") ? [] : out.lines();
	return {
		exit,
		stdout: out.text(),
		lines,
		stderr: out.errors,
		last: lines.at(-1) as Line,
		record: lines.find((line) => line["type"] === "record"),
	};
};

describe("with a working credential", () => {
	test("emits one record and one trailer, and exits 0", async () => {
		const run = await runWith([okFixture()]);

		expect(run.exit).toBe(0);
		expect(run.lines).toHaveLength(2);
		expect(run.lines[0]?.["type"]).toBe("record");
		expect(run.lines[0]?.["record_type"]).toBe("whoami");
		expect(run.last["type"]).toBe("summary");
		expect(run.last["complete"]).toBe(true);
		expect(run.last["emitted"]).toBe(1);
		expect(run.last["requests"]).toBe(1);
	});

	test("carries the user, the company and the local join", async () => {
		const { record } = await runWith([okFixture()]);

		expect(record).toMatchObject({
			id: 14182285,
			name: "antti lahtinen",
			email: "antti@example.com",
			active_flag: true,
			timezone_name: "Europe/Helsinki",
			company_id: 1234567,
			company_name: "Zimple",
			company_domain: "zimple",
			tier: "env",
		});
		expect(record?.["fingerprint"]).toHaveLength(16);
	});

	test("emits the fields in the documented order", async () => {
		const { record } = await runWith([okFixture()]);

		// The two line keys come first; the record's own order is the schema's.
		expect(Object.keys(record ?? {})).toEqual([
			"type",
			"record_type",
			"id",
			"name",
			"email",
			"active_flag",
			"timezone_name",
			"company_id",
			"company_name",
			"company_domain",
			"tier",
			"fingerprint",
		]);
	});

	test("reports the tier and fingerprint pd auth status reports", async () => {
		const env = { PD_API_TOKEN: "a-token", XDG_CACHE_HOME: cacheHome };
		const { record } = await runWith([okFixture()]);
		const status = authStatus({
			platform: "linux",
			env,
			home: "/home/nobody",
		});

		expect(status.isOk()).toBe(true);
		const value = status._unsafeUnwrap();
		expect(record?.["tier"]).toBe(value.tier as string);
		expect(record?.["fingerprint"]).toBe(value.fingerprint as string);
	});

	test("never prints the token", async () => {
		expect((await runWith([okFixture()])).stdout).not.toContain("a-token");
	});

	test("has no works field", async () => {
		const { record } = await runWith([okFixture()]);

		expect(record).not.toHaveProperty("works");
	});

	// ADR-0033 §6: there is no cache path, so a second run costs a second
	// request. The count is the same warm or cold because neither run is warm.
	test("reports requests: 1 on a second run too", async () => {
		expect((await runWith([okFixture()])).last["requests"]).toBe(1);
		expect((await runWith([okFixture()])).last["requests"]).toBe(1);
	});

	test("--no-cache is not a flag this command takes", async () => {
		const run = await runWith(undefined, ["--no-cache"]);

		expect(run.exit).toBe(2);
		expect(run.last["code"]).toBe("usage");
	});
});

describe("the two derived admin fields", () => {
	test("appear when access is present", async () => {
		const { record } = await runWith([okFixture(meBody({ access: ACCESS }))]);

		expect(record?.["is_global_admin"]).toBe(true);
		expect(record?.["is_deal_admin"]).toBe(false);
	});

	test("are omitted, not false, when access is absent", async () => {
		const { record } = await runWith([okFixture()]);

		expect(record).not.toHaveProperty("is_global_admin");
		expect(record).not.toHaveProperty("is_deal_admin");
	});

	test("are omitted when access is null", async () => {
		const { record } = await runWith([okFixture(meBody({ access: null }))]);

		expect(record).not.toHaveProperty("is_global_admin");
		expect(record).not.toHaveProperty("is_deal_admin");
	});
});

describe("when the credential does not work", () => {
	test("a rejected token exits 1 as auth, with no record", async () => {
		const run = await runWith([
			{ path: ME_PATH, status: 401, body: { success: false } },
		]);

		expect(run.exit).toBe(1);
		expect(run.last["type"]).toBe("error");
		expect(run.last["code"]).toBe("auth");
		expect(run.lines.filter((line) => line["type"] === "record")).toHaveLength(
			0,
		);
	});

	test("no credential anywhere exits 1 as auth, not 0 and not found:false", async () => {
		const run = await runWith(undefined, [], {});

		expect(run.exit).toBe(1);
		expect(run.last["code"]).toBe("auth");
		expect(run.last).not.toHaveProperty("found");
	});

	test("a transport failure exits 1 as upstream", async () => {
		const run = await runWith(undefined, [], undefined, () =>
			Promise.reject(new Error("network is unreachable")),
		);

		expect(run.exit).toBe(1);
		expect(run.last["code"]).toBe("upstream");
	});

	test("a 429 exits 3", async () => {
		const run = await runWith([{ path: ME_PATH, status: 429 }]);

		expect(run.exit).toBe(3);
		expect(run.last["exit_code"]).toBe(3);
		expect(["rate_limited", "budget_exhausted"]).toContain(
			run.last["code"] as string,
		);
	});

	test("an unreadable identity is invalid_response, not auth", async () => {
		const run = await runWith([
			okFixture({ success: true, data: { name: "no id here" } }),
		]);

		expect(run.exit).toBe(1);
		expect(run.last["code"]).toBe("invalid_response");
	});
});

describe("the output flags", () => {
	test("--fields company_domain selects a single key", async () => {
		const { record } = await runWith([okFixture()], [
			"--fields",
			"company_domain",
		]);

		expect(Object.keys(record ?? {})).toEqual([
			"type",
			"record_type",
			"id",
			"company_domain",
		]);
	});

	test("--fields refuses a name the record has no field for", async () => {
		const run = await runWith(undefined, ["--fields", "nonesuch"]);

		expect(run.exit).toBe(2);
		expect(run.last["code"]).toBe("usage");
	});

	test("--pretty writes human text rather than NDJSON", async () => {
		const run = await runWith([okFixture()], ["--pretty"]);

		expect(run.exit).toBe(0);
		expect(run.stdout).not.toContain('"record_type"');
		expect(run.stdout).toContain("company_domain");
		expect(run.stdout).toContain("zimple");
	});
});

describe("the manifest", () => {
	const manifest = createManifest("1.1.0");
	const entry = manifest.commands.other.find(
		(command) => command.name === "pd auth whoami",
	);

	test("lists the command as a streaming NDJSON command", () => {
		expect(entry?.delivery).toBe("streams");
		expect(manifest.non_ndjson_stdout).not.toContain("pd auth whoami");
	});

	test("publishes its selectable fields", () => {
		expect(entry?.selectable_fields).toEqual([
			"id",
			"name",
			"email",
			"active_flag",
			"timezone_name",
			"is_global_admin",
			"is_deal_admin",
			"company_id",
			"company_name",
			"company_domain",
			"tier",
			"fingerprint",
		]);
	});

	test("publishes its flags", () => {
		expect(entry?.flags).toEqual([
			"--pretty",
			"--token-file <path>",
			"--max-requests <n>",
			"--verbose",
			"--fields <a,b>",
		]);
	});

	// ADR-0033 §2: the error model is inherited whole, so the codes this command
	// answers with are already in the shared vocabulary with their exit codes.
	test("gives every code this command can answer an exit code", () => {
		const codes = new Map(
			manifest.vocabularies.error_codes.map((entry) => [
				entry.code,
				entry.exit_code,
			]),
		);

		expect(codes.get("auth")).toBe(1);
		expect(codes.get("upstream")).toBe(1);
		expect(codes.get("usage")).toBe(2);
		expect(codes.get("rate_limited")).toBe(3);
		expect(codes.get("budget_exhausted")).toBe(3);
	});

	test("says nothing about a works field", () => {
		expect(JSON.stringify(manifest)).not.toContain("works");
	});
});

describe("pd auth status", () => {
	test("is unchanged: still zero requests and no new field", () => {
		const status = authStatus({
			platform: "linux",
			env: { PD_API_TOKEN: "a-token", XDG_CACHE_HOME: cacheHome },
			home: "/home/nobody",
			dirExists: () => false,
		});

		// The `env` tier has no file, so `path` is absent by design.
		expect(Object.keys(status._unsafeUnwrap())).toEqual([
			"found",
			"tier",
			"fingerprint",
			"cache_dir_exists",
			"credential_is_write_capable",
			"warnings",
		]);
	});

	test("still exits 0 with nothing found", () => {
		const status = authStatus({
			platform: "linux",
			env: {},
			home: "/home/nobody",
			dirExists: () => false,
		});

		expect(status._unsafeUnwrap().found).toBe(false);
	});
});
