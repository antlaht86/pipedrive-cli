import { describe, expect, test } from "bun:test";

import { route } from "../src/router.ts";
import { cachedPage, stage } from "./support/cached.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { organization } from "./support/records.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";

const run = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[],
) => {
	const out = capture();
	const exit = await route({
		argv,
		platform: "linux",
		env: { PD_API_TOKEN: "test-token" },
		home: "/home/nobody",
		...(fixtures === undefined
			? {}
			: { transport: createReplayTransport(fixtures) }),
		sink: out.sink,
		stderr: out.stderr,
	});
	const lines = out.lines();
	return { exit, lines, last: lines.at(-1) as Line };
};

const idsFixture = (
	requestedIds: readonly number[],
	returned?: readonly number[],
): Fixture => ({
	path: "/api/v2/organizations",
	query: { ids: requestedIds.join(","), limit: 500 },
	body: {
		success: true,
		data: (returned ?? requestedIds).map((id) => organization(id)),
		additional_data: { next_cursor: null },
	},
});

describe("--ids", () => {
	test("250 ids are deduplicated in caller order and issue exactly three requests", async () => {
		const ids = Array.from({ length: 250 }, (_, index) => index + 1);
		const chunks = [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)];
		const { exit, lines, last } = await run(
			chunks.map((chunk) => idsFixture(chunk)),
			["organizations", "list", "--ids", ids.join(",")],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ complete: true, emitted: 250, requests: 3 });
		expect(
			lines
				.filter((line) => line["type"] === "record")
				.map((line) => line["id"]),
		).toEqual(ids);
	});

	test("records are emitted in caller order even when Pipedrive reverses them", async () => {
		const { lines } = await run(
			[idsFixture([7, 9, 11], [11, 9, 7])],
			["organizations", "list", "--ids", "7,9,11"],
		);

		expect(
			lines
				.filter((line) => line["type"] === "record")
				.map((line) => line["id"]),
		).toEqual([7, 9, 11]);
	});

	test("--sort-by keeps the API's requested order instead of caller-id order", async () => {
		const fixture: Fixture = {
			...idsFixture([7, 9, 11], [11, 9, 7]),
			query: { ids: "7,9,11", limit: 500, sort_by: "update_time" },
		};
		const { lines } = await run(
			[fixture],
			["organizations", "list", "--ids", "7,9,11", "--sort-by", "update_time"],
		);

		expect(
			lines
				.filter((line) => line["type"] === "record")
				.map((line) => line["id"]),
		).toEqual([11, 9, 7]);
	});

	test("--limit still stops before later sorted chunks are requested", async () => {
		const ids = Array.from({ length: 250 }, (_, index) => index + 1);
		const first = ids.slice(0, 100);
		const fixture: Fixture = {
			...idsFixture(first),
			query: { ids: first.join(","), limit: 500, sort_by: "update_time" },
		};
		const { last } = await run(
			[fixture],
			[
				"organizations",
				"list",
				"--ids",
				ids.join(","),
				"--sort-by",
				"update_time",
				"--limit",
				"1",
			],
		);

		expect(last).toMatchObject({
			complete: false,
			emitted: 1,
			requests: 1,
			reason: "limit",
		});
	});

	test("duplicates cost the same request as the deduplicated set", async () => {
		const { exit, last } = await run(
			[idsFixture([7, 9, 11])],
			["organizations", "list", "--ids", "7,9,7,11,9"],
		);

		expect(exit).toBe(0);
		expect(last).toMatchObject({ emitted: 3, requests: 1 });
	});

	/**
	 * ADR-0029 §5 collapsed two questions into one. A record is rejected when its
	 * id cannot be read, and an id that cannot be read is also the id `--ids`
	 * never saw come back — so a rejected record is now always an unmatched id
	 * too, and both warnings are true at once. Before the narrowing a record
	 * could fail on `name` while its id read cleanly, and the pair could
	 * disagree.
	 */
	test("a record whose id cannot be read is both rejected and unmatched", async () => {
		const fixture = idsFixture([7, 9]);
		fixture.body = {
			success: true,
			data: [{ ...organization(7), id: "7" }, organization(9)],
			additional_data: { next_cursor: null },
		};
		const { lines, last } = await run(
			[fixture],
			["organizations", "list", "--ids", "7,9"],
		);
		const warningKinds = lines
			.filter((line) => line["type"] === "warning")
			.map((line) => line["kind"]);

		expect(warningKinds).toEqual(["record_rejected", "unmatched_ids"]);
		expect(last).toMatchObject({ complete: true, emitted: 1, skipped: 1 });
	});

	test("a record with an unexpected field type still matches its requested id", async () => {
		const fixture = idsFixture([7, 9]);
		fixture.body = {
			success: true,
			data: [organization(7, { name: null }), organization(9)],
			additional_data: { next_cursor: null },
		};
		const { lines, last } = await run(
			[fixture],
			["organizations", "list", "--ids", "7,9"],
		);

		expect(lines.filter((line) => line["type"] === "warning")).toEqual([]);
		expect(last).toMatchObject({ complete: true, emitted: 2, skipped: 0 });
	});

	test("omitted ids produce one unmatched_ids warning without making the run partial", async () => {
		const { exit, lines, last } = await run(
			[idsFixture([7, 9, 11, 13], [7, 13])],
			["organizations", "list", "--ids", "7,9,11,13"],
		);
		const warnings = lines.filter((line) => line["type"] === "warning");

		expect(exit).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			kind: "unmatched_ids",
			resource: "organizations",
		});
		expect(warnings[0]?.["message"]).toContain("2 of 4 requested ids");
		expect(last).toMatchObject({ complete: true, emitted: 2, requests: 1 });
	});
});

describe("offline filter validation", () => {
	for (const argv of [
		["organizations", "list", "--ids", "7,9", "--filter-id", "2"],
		["activities", "list", "--done", "--not-done"],
		["organizations", "list", "--updated-since", "2026-08-01"],
		["organizations", "list", "--updated-since", "2026-08-01T12:34:60Z"],
		["organizations", "list", "--person-id", "3"],
		["deals", "list", "--sort-by", "name"],
	]) {
		test(`${argv.slice(0, 2).join(" ")} refuses ${argv.slice(2).join(" ")} without dispatch`, async () => {
			const { exit, last } = await run(undefined, argv);
			expect(exit).toBe(2);
			expect(last).toMatchObject({ code: "usage", requests: 0 });
		});
	}
});

test("stages applies --pipeline-id to the cached whole list", async () => {
	const { exit, lines } = await run(
		[cachedPage("stages", [stage(1), stage(2, { pipeline_id: 2 })])],
		["stages", "list", "--pipeline-id", "2", "--no-cache"],
	);

	expect(exit).toBe(0);
	expect(
		lines.filter((line) => line["type"] === "record").map((line) => line["id"]),
	).toEqual([2]);
});

test("all RFC3339 spellings are accepted and sent verbatim", async () => {
	for (const timestamp of ["2026-08-01t00:00:00z", "1990-12-31T23:59:60Z"]) {
		const fixture: Fixture = {
			path: "/api/v2/organizations",
			query: { limit: 500, updated_since: timestamp },
			body: {
				success: true,
				data: [],
				additional_data: { next_cursor: null },
			},
		};
		const { exit } = await run(
			[fixture],
			["organizations", "list", "--updated-since", timestamp],
		);
		expect(exit).toBe(0);
	}
});

test("timestamps are sent verbatim and combine with update_time sorting", async () => {
	const since = "2026-08-01T00:00:00Z";
	const until = "2026-08-02T03:04:05+02:00";
	const fixture: Fixture = {
		path: "/api/v2/organizations",
		query: {
			limit: 500,
			updated_since: since,
			updated_until: until,
			sort_by: "update_time",
			sort_direction: "asc",
		},
		body: { success: true, data: [], additional_data: { next_cursor: null } },
	};

	const { exit, last } = await run(
		[fixture],
		[
			"organizations",
			"list",
			"--updated-since",
			since,
			"--updated-until",
			until,
			"--sort-by",
			"update_time",
			"--sort-direction",
			"asc",
		],
	);

	expect(exit).toBe(0);
	expect(last).toMatchObject({ complete: true, requests: 1 });
});
