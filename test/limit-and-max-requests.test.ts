/**
 * `--limit` and `--max-requests` end to end — ticket 06's acceptance criteria.
 *
 * The two flags are deliberately different things (ADR-0003). A **bound** is
 * what the caller wanted: reaching it is success, exit 0, and the trailer is a
 * `summary` carrying `reason: "limit"`. A **guard** is what the caller would
 * tolerate: reaching it is an `error` trailer carrying `code: "request_ceiling"`,
 * exit 3, and no `reason` at all.
 *
 * The bound's *mechanics* are asserted in `walk.test.ts`, which owns the
 * marker-may-not-lie table. What is asserted here is the whole command: the
 * flags parse, the walk stops where it should, the trailer says which kind of
 * stop it was, and a bad value never reaches the network.
 */

import { describe, expect, test } from "bun:test";

import { route } from "../src/router.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { DEALS_PATH, deal, dealsPage, dealsQuery } from "./support/deals.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { FakeClock } from "./support/clock.ts";

type Run = {
	exit: number;
	lines: Line[];
	stderr: string[];
	last: Line;
};

const runWith = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[],
): Promise<Run> => {
	const out = capture();
	const exit = await route({
		argv,
		platform: "linux",
		env: { PD_API_TOKEN: "test-token" },
		home: "/home/nobody",
		...(fixtures === undefined
			? {}
			: { transport: createReplayTransport(fixtures) }),
		// Virtual time: a retry test would otherwise stall on the real backoff.
		clock: new FakeClock(),
		sink: out.sink,
		stderr: out.stderr,
	});
	const lines = out.lines();
	return {
		exit,
		lines,
		stderr: out.errors,
		last: lines[lines.length - 1] as Line,
	};
};

const run = (
	fixtures: readonly Fixture[],
	argv: readonly string[] = [],
): Promise<Run> => runWith(fixtures, ["deals", "list", ...argv]);

const page = (
	data: unknown[],
	nextCursor: string | null,
	cursor?: string,
): Fixture => ({
	path: DEALS_PATH,
	query: dealsQuery(cursor),
	body: dealsPage(data, nextCursor),
});

const deals = (from: number, count: number): Record<string, unknown>[] =>
	Array.from({ length: count }, (_, i) => deal(from + i));

const of = (lines: Line[], type: string): Line[] =>
	lines.filter((line) => line["type"] === type);

describe("--limit is a bound: exit 0 and a summary", () => {
	test("a limit that cuts a page short emits exactly that many records", async () => {
		const { exit, lines, last } = await run(
			[page(deals(1, 10), "c2")],
			["--limit", "4"],
		);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 2, 3, 4]);
		expect(last).toMatchObject({
			type: "summary",
			complete: false,
			emitted: 4,
			reason: "limit",
		});
	});

	test("a limit larger than the data is not a bound at all", async () => {
		const { exit, last } = await run(
			[page(deals(1, 3), null)],
			["--limit", "100"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ type: "summary", complete: true, emitted: 3 });
		expect("reason" in last).toBe(false);
	});

	test("a limit spanning pages keeps fetching until it fills", async () => {
		const { exit, lines, last } = await run(
			[page(deals(1, 2), "c2"), page(deals(3, 2), "c3", "c2")],
			["--limit", "3"],
		);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 2, 3]);
		expect(last).toMatchObject({ emitted: 3, requests: 2, reason: "limit" });
	});

	test("the limit counts after rejection and deduplication", async () => {
		// Page one offers five elements: one the schema rejects and one already
		// seen. Asking for three must still write three, and must therefore reach
		// page two rather than stopping at the three survivors of page one.
		const { exit, lines, last } = await run(
			[
				page([deal(1), deal(2, { person_id: "nope" }), deal(1), deal(3)], "c2"),
				page(deals(4, 2), "c3", "c2"),
			],
			["--limit", "3"],
		);

		expect(exit).toBe(0);
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 3, 4]);
		expect(last).toMatchObject({
			emitted: 3,
			skipped: 1,
			duplicates: 1,
			reason: "limit",
		});
	});

	test("a limit filling exactly at a page boundary with a null cursor is complete", async () => {
		const { exit, last } = await run(
			[page(deals(1, 2), null)],
			["--limit", "2"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ complete: true, emitted: 2 });
		expect("reason" in last).toBe(false);
	});

	test("a limit filling where the cursor continues reports complete: false", async () => {
		const { exit, last } = await run(
			[page(deals(1, 2), "c2")],
			["--limit", "2"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({
			complete: false,
			emitted: 2,
			reason: "limit",
		});
		// The conservative error is deliberate: the next page may well have been
		// empty, and there is no way to know that without spending a request.
		expect(last["requests"]).toBe(1);
	});
});

describe("--max-requests is a guard: exit 3 and an error", () => {
	const many = (): Fixture[] => [
		page(deals(1, 2), "c2"),
		page(deals(3, 2), "c3", "c2"),
		page(deals(5, 2), "c4", "c3"),
	];

	test("the ceiling ends the run with request_ceiling, exit 3", async () => {
		const { exit, lines, last } = await run(many(), ["--max-requests", "2"]);

		expect(exit).toBe(3);
		// The records already written stay written.
		expect(of(lines, "record").map((line) => line["id"])).toEqual([1, 2, 3, 4]);
		expect(last).toMatchObject({
			type: "error",
			code: "request_ceiling",
			exit_code: 3,
			retry: "never",
			complete: false,
			emitted: 4,
			requests: 2,
			details: { max_requests: 2 },
		});
	});

	test("the guard stop carries no reason field", async () => {
		// ADR-0003: `reason` belongs exclusively to a bounded `summary`. There is
		// no `reason: "max_requests"`, whatever ADR-0008 §10 and ADR-0018 §3 say.
		const { last } = await run(many(), ["--max-requests", "1"]);

		expect("reason" in last).toBe(false);
	});

	test("it aborts before the ceiling is exceeded, never after", async () => {
		const { exit, last } = await run(many(), ["--max-requests", "1"]);

		expect(exit).toBe(3);
		expect(last["requests"]).toBe(1);
	});

	test("a run that fits under the ceiling is an ordinary success", async () => {
		const { exit, last } = await run(
			[page(deals(1, 2), null)],
			["--max-requests", "9"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({
			type: "summary",
			complete: true,
			requests: 1,
		});
	});

	test("retries count against the headroom", async () => {
		// Two 500s and then a page that would succeed. With three requests of
		// headroom the retries spend all of it, so the run stops on the ceiling
		// rather than on the page it never reached.
		const failure: Fixture = {
			path: DEALS_PATH,
			query: dealsQuery(),
			status: 500,
			body: { success: false },
		};
		const { exit, last } = await run(
			[failure, failure, page(deals(1, 1), null)],
			["--max-requests", "2"],
		);

		expect(exit).toBe(3);
		expect(last).toMatchObject({
			code: "request_ceiling",
			requests: 2,
			emitted: 0,
		});
	});

	test("the guard wins over the bound when both are reachable", async () => {
		const { exit, last } = await run(many(), [
			"--limit",
			"1000",
			"--max-requests",
			"2",
		]);

		expect(exit).toBe(3);
		expect(last["code"]).toBe("request_ceiling");
	});

	test("the bound wins when it fills first", async () => {
		const { exit, last } = await run(many(), [
			"--limit",
			"2",
			"--max-requests",
			"9",
		]);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ reason: "limit", emitted: 2 });
	});

	test("the ceiling applies to get as well as to list", async () => {
		// ADR-0003 scopes only `--limit` to list commands. The guard is about the
		// size of a run, and `get` is a run.
		const { exit, last } = await runWith(
			[{ path: `${DEALS_PATH}/42`, body: { success: true, data: deal(42) } }],
			["deals", "get", "42", "--max-requests", "5"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ type: "summary", complete: true, emitted: 1 });
	});
});

describe("--limit does not exist on a non-list command", () => {
	test("pd deals get --limit is a usage error, exit 2, and no request", async () => {
		const { exit, lines, last } = await runWith(undefined, [
			"deals",
			"get",
			"42",
			"--limit",
			"5",
		]);

		expect(exit).toBe(2);
		expect(lines).toHaveLength(1);
		expect(last).toMatchObject({
			type: "error",
			code: "usage",
			exit_code: 2,
			requests: 0,
		});
		expect(String(last["message"])).toContain("--limit");
	});

	test("the get refusal still names the flags get does take", async () => {
		const { last } = await runWith(undefined, [
			"deals",
			"get",
			"42",
			"--limit",
			"5",
		]);

		expect(last["message"]).toBe(
			"pd deals get does not accept --limit. It takes --token-file, --max-requests, --resolve-budget, --no-cache, --resolve, --verbose and --fields and no other flag.",
		);
	});
});

describe("quantitative flags reject their bad values offline", () => {
	// No fixtures: the default transport throws, so `requests: 0` on the trailer
	// is the assertion that nothing reached Pipedrive.
	const bad = async (flag: string, value: string): Promise<Run> =>
		runWith(undefined, ["deals", "list", flag, value]);

	for (const flag of ["--limit", "--max-requests", "--resolve-budget"]) {
		for (const value of [
			"0",
			"-1",
			"1.5",
			"abc",
			"",
			" 4",
			"4 ",
			"1e3",
			"0x10",
		]) {
			test(`${flag} ${JSON.stringify(value)} is usage, exit 2, and no request`, async () => {
				const { exit, lines, last } = await bad(flag, value);

				expect(exit).toBe(2);
				expect(lines).toHaveLength(1);
				expect(last).toMatchObject({
					code: "usage",
					exit_code: 2,
					requests: 0,
				});
				expect(String(last["message"])).toContain(flag);
			});
		}
	}

	test("a flag with no value at all is a usage error", async () => {
		const { exit, last } = await runWith(undefined, [
			"deals",
			"list",
			"--limit",
		]);

		expect(exit).toBe(2);
		expect(last["code"]).toBe("usage");
	});

	test("the message says what a good value looks like", async () => {
		const { last } = await bad("--limit", "0");

		expect(last["message"]).toBe(
			"--limit takes a positive integer of 1 or greater.",
		);
	});
});
