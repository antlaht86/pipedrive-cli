/**
 * `pd deals list` end to end — ticket 05's acceptance criteria.
 *
 * Every test drives the real command through fixture replay (ADR-0019 §2), so
 * the walk, the two validation stages, the deduplication, the writer, the error
 * union and the exit codes are exercised together rather than in isolation.
 * The default transport throws, so any request these tests forgot to record
 * fails the run rather than reaching Pipedrive (ADR-0019 §3).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { DEALS_PATH, deal, dealsPage, dealsQuery } from "./support/deals.ts";
import { capture, type Line } from "./support/ndjson.ts";

type Run = {
	exit: number;
	stdout: string;
	lines: Line[];
	stderr: string[];
	last: Line;
};

/**
 * Fresh per test, so the sentinel the Cloudflare case writes ends with that
 * test rather than refusing every run after it.
 */
let cacheHome = "";

beforeEach(() => {
	cacheHome = mkdtempSync(`${tmpdir()}/pd-deals-`);
});

afterEach(() => {
	rmSync(cacheHome, { recursive: true, force: true });
});

/**
 * One run of `pd deals list` against a fixture set, with stdout and stderr
 * captured. `transport` is omitted when there are no fixtures: the default
 * transport throws, so "and no request was made" is asserted by the absence
 * rather than by a count.
 */
const runWith = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[],
	env: Record<string, string | undefined>,
): Promise<Run> => {
	const out = capture();
	const exit = await route({
		argv: ["deals", "list", ...argv],
		platform: "linux",
		// The cache home is a directory this file owns and deletes, because the
		// Cloudflare case below writes the `blocked` sentinel (ADR-0010 §6). Left
		// pointing at the caller's home it would block the next test rather than
		// the next invocation.
		env: { ...env, XDG_CACHE_HOME: cacheHome },
		home: "/home/nobody",
		...(fixtures === undefined
			? {}
			: { transport: createReplayTransport(fixtures) }),
		sink: out.sink,
		stderr: out.stderr,
	});
	const lines = out.lines();
	return {
		exit,
		stdout: out.text(),
		lines,
		stderr: out.errors,
		last: lines[lines.length - 1] as Line,
	};
};

const run = (
	fixtures: readonly Fixture[],
	argv: readonly string[] = [],
): Promise<Run> => runWith(fixtures, argv, { PD_API_TOKEN: "test-token" });

const page = (
	data: unknown[],
	nextCursor: string | null,
	cursor?: string,
): Fixture => ({
	path: DEALS_PATH,
	query: dealsQuery(cursor),
	body: dealsPage(data, nextCursor),
});

const of = (lines: Line[], type: string): Line[] =>
	lines.filter((line) => line["type"] === type);

describe("the walk", () => {
	test("--verbose changes no stdout byte and forces request diagnostics without a TTY", async () => {
		const fixture = { ...page([deal(1)], null), headers: { age: "12" } };
		const normal = await run([fixture], ["--limit", "1"]);
		const verbose = await run([fixture], ["--limit", "1", "--verbose"]);

		expect(verbose.stdout).toBe(normal.stdout);
		const diagnostics = verbose.stderr.join("");
		expect(diagnostics).toContain("GET /api/v2/deals");
		expect(diagnostics).toContain("status=200");
		expect(diagnostics).toContain("attempt=1");
		expect(diagnostics).toContain("cache_hit=yes");
		expect(diagnostics).not.toContain("age=12");
		expect(diagnostics).toContain("pd: finished:");
	});

	test("a default non-TTY replay is silent on success and emits only the error summary on failure", async () => {
		const success = await run([page([deal(1)], null)], ["--limit", "1"]);
		expect(success.stderr).toEqual([]);

		const failure = await run(
			[{ ...page([], null), status: 401 }],
			["--limit", "1"],
		);
		expect(failure.stderr).toHaveLength(1);
		expect(failure.stderr[0]).toStartWith("pd: ");
		expect(failure.stderr[0]).not.toContain("\r");

		const large = await run([
			page(
				Array.from({ length: 10_000 }, (_, index) => deal(index + 1)),
				null,
			),
		]);
		expect(large.stderr).toEqual([
			"pd: 10000 records emitted so far. Pass --limit to bound the walk.\n",
		]);
	});

	test("does not add aliases or logging controls beside --verbose", async () => {
		for (const argv of [["-v"], ["--quiet"], ["--log-format", "json"]]) {
			const result = await runWith(undefined, argv, {
				PD_API_TOKEN: "test-token",
			});
			expect(result.exit).toBe(2);
			expect(result.last["code"]).toBe("usage");
		}
	});

	test("walks every page to a null cursor and emits one record line per deal", async () => {
		const { exit, lines, last } = await run([
			page([deal(1), deal(2)], "c2"),
			page([deal(3)], "c3", "c2"),
			page([deal(4)], null, "c3"),
		]);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 2, 3, 4]);
		expect(last["type"]).toBe("summary");
		expect(last["complete"]).toBe(true);
		expect(last["emitted"]).toBe(4);
	});

	test("the trailer carries every field ADR-0003 makes mandatory", async () => {
		const { last } = await run([page([deal(1)], null)]);

		expect(last).toEqual({
			type: "summary",
			complete: true,
			emitted: 1,
			skipped: 0,
			duplicates: 0,
			resolved: "off",
			requests: 1,
		});
	});

	test("there is exactly one trailer", async () => {
		const { lines } = await run([
			page([deal(1)], "c2"),
			page([deal(2)], null, "c2"),
		]);

		expect(
			lines.filter(
				(line) => line["type"] === "summary" || line["type"] === "error",
			),
		).toHaveLength(1);
	});

	test("record lines are tagged with the singular record_type", async () => {
		const { lines } = await run([page([deal(1)], null)]);

		expect(of(lines, "record")[0]?.["record_type"]).toBe("deal");
	});

	test("an empty result set is an empty success, not not_found", async () => {
		const { exit, lines, last } = await run([page([], null)]);

		expect(exit).toBe(0);
		expect(of(lines, "record")).toHaveLength(0);
		expect(last).toMatchObject({ type: "summary", complete: true, emitted: 0 });
	});

	test("a last page with next_cursor null completes the walk", async () => {
		// The regression this guards: the v2 spec types `next_cursor` as a required
		// string, so without the nullability patch the last page of *every* list
		// would fail the envelope and end the run as invalid_response.
		const { exit, last } = await run([page([deal(1)], null)]);

		expect(exit).toBe(0);
		expect(last["complete"]).toBe(true);
	});

	test("an absent additional_data block ends the walk rather than failing it", async () => {
		const { exit, last } = await run([
			{
				path: DEALS_PATH,
				query: dealsQuery(),
				body: { success: true, data: [deal(1)] },
			},
		]);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ type: "summary", complete: true, emitted: 1 });
	});
});

describe("structural failures end the walk", () => {
	test("a body that is not JSON is invalid_response, exit 1", async () => {
		const { exit, last, stderr } = await run([
			{ path: DEALS_PATH, query: dealsQuery(), body: "<html>nope</html>" },
		]);

		expect(exit).toBe(1);
		expect(last).toMatchObject({
			type: "error",
			code: "invalid_response",
			exit_code: 1,
			retry: "never",
			complete: false,
			emitted: 0,
		});
		expect(stderr.join("")).toStartWith("pd: ");
	});

	test("data absent is invalid_response", async () => {
		const { exit, last } = await run([
			{ path: DEALS_PATH, query: dealsQuery(), body: { success: true } },
		]);

		expect(exit).toBe(1);
		expect(last["code"]).toBe("invalid_response");
	});

	test("data not an array is invalid_response", async () => {
		const { exit, last } = await run([
			{
				path: DEALS_PATH,
				query: dealsQuery(),
				body: { success: true, data: {} },
			},
		]);

		expect(exit).toBe(1);
		expect(last["code"]).toBe("invalid_response");
	});

	test("next_cursor of the wrong type is invalid_response", async () => {
		const { exit, last } = await run([
			{
				path: DEALS_PATH,
				query: dealsQuery(),
				body: { success: true, data: [], additional_data: { next_cursor: 7 } },
			},
		]);

		expect(exit).toBe(1);
		expect(last["code"]).toBe("invalid_response");
	});

	test("records already written stay written when a later page dies", async () => {
		const { exit, lines, last } = await run([
			page([deal(1), deal(2)], "c2"),
			{
				path: DEALS_PATH,
				query: dealsQuery("c2"),
				body: { success: true, data: "no" },
			},
		]);

		expect(exit).toBe(1);
		expect(of(lines, "record")).toHaveLength(2);
		expect(last).toMatchObject({ type: "error", complete: false, emitted: 2 });
	});
});

/**
 * ADR-0029 §1: the interior of a record is carried, never read, so nothing in
 * it can reject the record. These are the cases the generated `zGetDealsItem`
 * used to fail, and each one is a shape a real account returns.
 */
describe("the record interior passes through", () => {
	test("an open deal with no won_time, lost_time or expected_close_date emits", async () => {
		const open = deal(1);
		delete open["won_time"];
		delete open["lost_time"];
		delete open["expected_close_date"];

		const { exit, lines, last } = await run([page([open], null)]);

		expect(exit).toBe(0);
		expect(of(lines, "warning")).toEqual([]);
		expect(last).toMatchObject({ complete: true, emitted: 1, skipped: 0 });
	});

	test("a field the vendored spec does not declare is emitted, not stripped", async () => {
		const { lines } = await run([
			page([deal(1, { a_field_pipedrive_shipped_last_week: "kept" })], null),
		]);

		expect(of(lines, "record")[0]).toMatchObject({
			a_field_pipedrive_shipped_last_week: "kept",
		});
	});

	test("a value of the wrong declared type is carried rather than rejected", async () => {
		const { exit, lines, last } = await run([
			page([deal(1, { person_id: "nope", title: 42 })], null),
		]);

		expect(exit).toBe(0);
		expect(of(lines, "warning")).toEqual([]);
		expect(of(lines, "record")[0]).toMatchObject({
			person_id: "nope",
			title: 42,
		});
		expect(last).toMatchObject({ emitted: 1, skipped: 0 });
	});

	test("no absent field is materialised from a spec default", async () => {
		const bare = { id: 7, title: "Bare" };
		const { lines } = await run([page([bare], null)]);

		const record = of(lines, "record")[0] as Line;
		expect(record).toEqual({ type: "record", record_type: "deal", ...bare });
	});

	test("key order on the line is key order on the wire", async () => {
		const { stdout } = await run([
			page([{ zulu: 1, alpha: 2, id: 3, mike: 4 }], null),
		]);

		const record = stdout.split("\n").find((line) => line.includes('"zulu"'));
		expect(record).toContain('"zulu":1,"alpha":2,"id":3,"mike":4');
	});
});

describe("per-record rejection", () => {
	/**
	 * ADR-0029 §5 narrowed the trigger to "not an object with a usable
	 * identity". A record with no integer `id` cannot be deduplicated, which is
	 * the one thing the walk needs from a record's interior.
	 */
	test("one record with no usable id is one warning and skipped += 1; the page survives", async () => {
		const { exit, lines, last } = await run([
			page([deal(1), { ...deal(2), id: "nope" }, deal(3)], null),
		]);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 3]);
		expect(of(lines, "warning")).toEqual([
			{
				type: "warning",
				kind: "record_rejected",
				resource: "deal",
				path: "",
				issue: "custom",
				// `message` is human prose and may change freely; `kind`, `resource`,
				// `path` and `issue` are the interface.
				message: "The record is not an object with an integer id.",
			},
		]);
		expect(last).toMatchObject({ complete: true, emitted: 2, skipped: 1 });
	});

	test("the warning's id is omitted, never null, when it cannot be recovered", async () => {
		const { lines } = await run([page([deal(1), { id: "not-an-int" }], null)]);

		const warning = of(lines, "warning")[0] as Line;
		expect("id" in warning).toBe(false);
	});

	test("warnings deduplicate by cause while skipped counts every record", async () => {
		const broken = [2, 3, 4, 5].map((id) => ({ ...deal(id), id: `x${id}` }));
		const { lines, last } = await run([page([deal(1), ...broken], null)]);

		expect(of(lines, "warning")).toHaveLength(1);
		expect(last).toMatchObject({ emitted: 1, skipped: 4 });
	});

	test("a record that is not an object at all is rejected", async () => {
		const { exit, lines, last } = await run([
			page([deal(1), "not a record", null, 42], null),
		]);

		expect(exit).toBe(0);
		expect(of(lines, "warning")).toHaveLength(1);
		expect(last).toMatchObject({ complete: true, emitted: 1, skipped: 3 });
	});

	test("a first page whose non-empty data yields zero survivors is invalid_response", async () => {
		const { exit, lines, last } = await run([
			page([{ id: "nope" }, { id: "also-nope" }], "c2"),
		]);

		expect(exit).toBe(1);
		// The page is atomic: it is an Err, so none of its warnings were written.
		expect(lines).toHaveLength(1);
		expect(last).toMatchObject({
			type: "error",
			code: "invalid_response",
			emitted: 0,
			skipped: 0,
		});
	});

	test("a wholly rejected later page is survivable, not an escalation", async () => {
		const { exit, last } = await run([
			page([deal(1)], "c2"),
			page([{ id: "nope" }, { id: "also-nope" }], null, "c2"),
		]);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ complete: true, emitted: 1, skipped: 2 });
	});

	test("an empty first page is an empty success, not zero survivors", async () => {
		const { exit, last } = await run([page([], null)]);

		expect(exit).toBe(0);
		expect(last["code"]).toBeUndefined();
	});
});

describe("deduplication", () => {
	test("records repeated across pages are suppressed and counted", async () => {
		const { exit, lines, last } = await run([
			page([deal(1), deal(2)], "c2"),
			page([deal(2), deal(3)], null, "c2"),
		]);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 2, 3]);
		expect(last).toMatchObject({ emitted: 3, duplicates: 1, complete: true });
	});

	test("deduplication holds every id for the whole run, with no window", async () => {
		const { last } = await run([
			page([deal(1)], "c2"),
			page([deal(2)], "c3", "c2"),
			page([deal(3)], "c4", "c3"),
			page([deal(1), deal(4)], null, "c4"),
		]);

		expect(last).toMatchObject({ emitted: 4, duplicates: 1 });
	});
});

describe("value formatting and absence", () => {
	test("null-valued fields are absent keys and empty values survive", async () => {
		const { lines } = await run([
			page(
				[
					deal(1, {
						probability: null,
						lost_reason: null,
						close_time: null,
						label_ids: [],
						origin: "",
						value: 0,
					}),
				],
				null,
			),
		]);

		const record = of(lines, "record")[0] as Line;
		expect("probability" in record).toBe(false);
		expect("lost_reason" in record).toBe(false);
		expect("close_time" in record).toBe(false);
		expect(record["label_ids"]).toEqual([]);
		expect(record["origin"]).toBe("");
		expect(record["value"]).toBe(0);
		expect(record["id"]).toBe(1);
	});

	test("custom_fields passes through byte-identically and is {} when empty", async () => {
		const hash = "8a1b3c9d2e4f5061728394a5b6c7d8e9f0a1b2c3";
		const custom = { [hash]: { value: 500, currency: "USD" }, other: null };
		const { lines } = await run([
			page([deal(1, { custom_fields: custom }), deal(2)], null),
		]);

		const [first, second] = of(lines, "record") as [Line, Line];
		expect(first["custom_fields"]).toEqual(custom);
		expect(JSON.stringify(first["custom_fields"])).toBe(JSON.stringify(custom));
		expect(second["custom_fields"]).toEqual({});
	});

	test("money is a JSON number with currency as a flat sibling", async () => {
		const { lines } = await run([page([deal(1, { value: 12000.5 })], null)]);

		const record = of(lines, "record")[0] as Line;
		expect(record["value"]).toBe(12000.5);
		expect(record["currency"]).toBe("EUR");
	});

	test("time passes through byte for byte", async () => {
		const { lines } = await run([
			page([deal(1, { add_time: "2021-01-01 00:00:00" })], null),
		]);

		expect((of(lines, "record")[0] as Line)["add_time"]).toBe(
			"2021-01-01 00:00:00",
		);
	});
});

describe("streaming", () => {
	test("the first record reaches stdout before the second page is fetched", async () => {
		// ADR-0002 measured 250 ms to first byte against 20 s buffered. Wall time is
		// not the assertion — the ordering that produces it is.
		const replay = createReplayTransport([
			page([deal(1)], "c2"),
			page([deal(2)], null, "c2"),
		]);
		let served = 0;
		let servedAtFirstWrite = -1;

		await route({
			argv: ["deals", "list"],
			platform: "linux",
			env: { PD_API_TOKEN: "test-token" },
			home: "/home/nobody",
			transport: (request) => {
				served += 1;
				return replay(request);
			},
			sink: (line) => {
				if (servedAtFirstWrite === -1 && line.includes('"type":"record"')) {
					servedAtFirstWrite = served;
				}
			},
			stderr: () => {},
		});

		expect(servedAtFirstWrite).toBe(1);
		expect(served).toBe(2);
	});
});

describe("the credential on the wire", () => {
	test("the token rides in x-api-token, and only there", async () => {
		// The v2 spec declares two security schemes on every operation. A bare
		// token would satisfy both and send the credential twice; this is the
		// assertion that `apiKeyOnly` keeps doing its job across a regeneration.
		const replay = createReplayTransport([page([deal(1)], null)]);
		const seen: Request[] = [];

		const exit = await route({
			argv: ["deals", "list"],
			platform: "linux",
			env: { PD_API_TOKEN: "test-token" },
			home: "/home/nobody",
			transport: (request) => {
				seen.push(request);
				return replay(request);
			},
			sink: () => {},
			stderr: () => {},
		});

		expect(exit).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("x-api-token")).toBe("test-token");
		expect(seen[0]?.headers.get("authorization")).toBeNull();
	});

	test("the request is a GET at the v2 base URL, with the fixed page size", async () => {
		const replay = createReplayTransport([page([deal(1)], null)]);
		let url = "";
		let method = "";

		await route({
			argv: ["deals", "list"],
			platform: "linux",
			env: { PD_API_TOKEN: "test-token" },
			home: "/home/nobody",
			transport: (request) => {
				url = request.url;
				method = request.method;
				return replay(request);
			},
			sink: () => {},
			stderr: () => {},
		});

		expect(method).toBe("GET");
		expect(url).toBe("https://api.pipedrive.com/api/v2/deals?limit=500");
	});
});

describe("argument and credential failures still end in a trailer", () => {
	const failing = (
		argv: readonly string[],
		env: Record<string, string | undefined> = { PD_API_TOKEN: "test-token" },
	): Promise<Run> => runWith(undefined, argv, env);

	test("an unknown flag is one error line, exit 2, and no request", async () => {
		const { exit, lines, last } = await failing(["--frobnicate"]);

		expect(exit).toBe(2);
		expect(lines).toHaveLength(1);
		// pd's own wording, not node:util's — that message advises a `--` positional
		// syntax this command does not have, and an agent is the one reading it.
		expect(last["message"]).toBe(
			"pd deals list does not accept --frobnicate. It takes --pretty, --token-file, --limit, --max-requests, --resolve-budget, --no-cache, --resolve, --verbose, --fields, --ids, --owner-id, --person-id, --org-id, --pipeline-id, --stage-id, --status, --updated-since, --updated-until, --sort-by, --sort-direction and --filter-id and no other flag.",
		);
		expect(last).toMatchObject({
			type: "error",
			code: "usage",
			exit_code: 2,
			complete: false,
			emitted: 0,
			skipped: 0,
			duplicates: 0,
			resolved: "off",
			requests: 0,
			details: {},
		});
	});

	test("--token is refused by name, with the reason", async () => {
		const { exit, last } = await failing(["--token", "abc"]);

		expect(exit).toBe(2);
		expect(last["code"]).toBe("usage");
		expect(String(last["message"])).toContain("--token-file");
	});

	test("a positional argument is a usage error", async () => {
		const { exit, last } = await failing(["42"]);

		expect(exit).toBe(2);
		expect(last["code"]).toBe("usage");
	});

	test("no credential anywhere is auth, exit 1, with the trailer fields", async () => {
		const { exit, last } = await failing([], {});

		expect(exit).toBe(1);
		expect(last).toMatchObject({
			type: "error",
			code: "auth",
			exit_code: 1,
			retry: "never",
			complete: false,
			emitted: 0,
			requests: 0,
		});
	});
});

describe("HTTP status mapping at the wrapper seam", () => {
	const status = (
		code: number,
		body: unknown = { success: false },
	): Fixture => ({
		path: DEALS_PATH,
		query: dealsQuery(),
		status: code,
		body,
	});

	test("401 is auth", async () => {
		const { exit, last } = await run([status(401)]);
		expect(exit).toBe(1);
		expect(last["code"]).toBe("auth");
	});

	test("a JSON 403 is forbidden, not blocked", async () => {
		const { exit, last } = await run([status(403)]);
		expect(exit).toBe(1);
		expect(last["code"]).toBe("forbidden");
	});

	test("404 is not_found", async () => {
		const { exit, last } = await run([status(404)]);
		expect(exit).toBe(1);
		expect(last["code"]).toBe("not_found");
	});

	test("an unexpected 4xx is internal, because pd composed the request", async () => {
		const { exit, last } = await run([status(400)]);
		expect(exit).toBe(1);
		expect(last["code"]).toBe("internal");
	});

	test("a Cloudflare HTML 403 is blocked, exit 3, and is never parsed as JSON", async () => {
		const { exit, last } = await run([
			{
				path: DEALS_PATH,
				query: dealsQuery(),
				status: 403,
				headers: { "content-type": "text/html" },
				body: "<!doctype html><html>Attention Required!</html>",
			},
		]);

		expect(exit).toBe(3);
		expect(last).toMatchObject({
			code: "blocked",
			exit_code: 3,
			retry: "not_today",
		});
	});
});
