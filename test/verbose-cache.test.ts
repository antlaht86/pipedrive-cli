/**
 * Ticket 25 — `--verbose` names `pd`'s own cache.
 *
 * ADR-0015 §5's per-request line reports the **upstream** cache, read from the
 * response's `age` / `x-cache` / `cf-cache-status` headers. `pd`'s own cache
 * short-circuits before a request is formed, so a hit on it can never appear on
 * that line: it emits one of its own. These tests hold both halves, and hold the
 * one property that makes the log answer "is the cache working" — a cold run and
 * a warm run of the same command differ on stderr alone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { route } from "../src/router.ts";
import {
	cachedPage,
	field,
	pipeline,
	stage,
	user,
	usersFixture,
} from "./support/cached.ts";
import { deal, dealsPage, dealsQuery, DEALS_PATH } from "./support/deals.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";

let home = "";
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/pd-verbose-cache-`);
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const HASH = "1111111111111111111111111111111111111111";

/** Every request a cold `deals list --resolve` dispatches, in any order. */
const fixtures = (): Fixture[] => [
	cachedPage("dealFields", [field(HASH, { name: "Sector" })]),
	usersFixture([user(11)]),
	cachedPage("pipelines", [pipeline(1)]),
	cachedPage("stages", [stage(4)]),
	{
		path: DEALS_PATH,
		query: dealsQuery(),
		body: dealsPage([deal(1)], null),
	},
];

type Run = {
	exit: number;
	stdout: string;
	stderr: string;
	last: Line;
};

const run = async (argv: readonly string[]): Promise<Run> => {
	const out = capture();
	const exit = await route({
		argv: [
			"deals",
			"list",
			"--resolve",
			// Enough of the projection to need all four cached entries, and not
			// `person_id` or `org_id`: ADR-0018's variable-cost expansion would add
			// requests that have nothing to do with this ticket.
			"--fields",
			"id,title,owner_id,pipeline_id,stage_id,custom_fields",
			...argv,
		],
		platform: "linux",
		env: { PD_API_TOKEN: "test-token", XDG_CACHE_HOME: `${home}/cache` },
		home,
		transport: createReplayTransport(fixtures()),
		sink: out.sink,
		stderr: out.stderr,
	});
	return {
		exit,
		stdout: out.text(),
		stderr: out.errors.join(""),
		last: out.last() as Line,
	};
};

const CACHED_ENTRIES = ["dealFields", "users", "pipelines", "stages"] as const;

describe("--verbose and pd's own cache", () => {
	test("a warm run names every entry it served from cache, and dispatched no request for it", async () => {
		const cold = await run(["--verbose"]);
		expect(cold.exit).toBe(0);
		const warm = await run(["--verbose"]);
		expect(warm.exit).toBe(0);

		for (const entry of CACHED_ENTRIES) {
			expect(cold.stderr).not.toContain(`pd: ${entry} served from cache`);
			expect(warm.stderr).toContain(
				`pd: ${entry} served from cache, no request\n`,
			);
			expect(warm.stderr).not.toContain(`GET /api/v2/${entry}`);
		}
	});

	test("a cold run and a warm run are distinguishable from the log alone", async () => {
		const cold = await run(["--verbose"]);
		const warm = await run(["--verbose"]);
		expect(cold.stderr).not.toBe(warm.stderr);
		expect(cold.stderr).not.toContain("served from cache");
		expect(warm.stderr).toContain("served from cache");
	});

	test("the per-request field names the upstream cache", async () => {
		const verbose = await run(["--verbose"]);
		expect(verbose.stderr).toContain("upstream_cache_hit=");
		expect(verbose.stderr).not.toContain(" cache_hit=");
	});

	test("a cache hit never moves the request counter, and stdout is unchanged", async () => {
		const cold = await run(["--verbose"]);
		const warm = await run(["--verbose"]);
		// The third run is warm too, so it differs from the second in `--verbose`
		// and in nothing else.
		const plain = await run([]);

		// §5: `--verbose` never changes a byte of stdout. The count itself does
		// change between cold and warm — that is the measurement the ticket rests
		// on — so the comparison is verbose against plain at the same temperature.
		expect(warm.stdout).toBe(plain.stdout);
		expect(cold.last["requests"]).toBe(5);
		expect(warm.last["requests"]).toBe(1);
	});

	test("a machine run stays byte-silent on stderr, warm or cold", async () => {
		const cold = await run([]);
		const warm = await run([]);
		expect(cold.stderr).toBe("");
		expect(warm.stderr).toBe("");
	});
});
