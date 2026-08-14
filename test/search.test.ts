import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { route } from "../src/router.ts";
import { capture, type Line } from "./support/ndjson.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { user, usersFixture } from "./support/cached.ts";

type SearchCase = {
	name: string;
	recordType: string;
	item: Record<string, unknown>;
	expected: Record<string, unknown>;
};

const CASES: readonly SearchCase[] = [
	{
		name: "deals",
		recordType: "deal_search_hit",
		item: {
			id: 1,
			type: "deal",
			title: "Acme renewal",
			value: 1200,
			currency: "EUR",
			status: "open",
			visible_to: 3,
			owner: { id: 11 },
			stage: { id: 21, name: "Qualified" },
			person: { id: 31, name: "Aino" },
			organization: { id: 41, name: "Acme" },
			custom_fields: ["Acme Oy"],
			notes: ["Asked for renewal"],
			is_archived: false,
		},
		expected: {
			id: 1,
			title: "Acme renewal",
			owner_id: 11,
			stage_id: 21,
			stage_name: "Qualified",
			person_id: 31,
			person_name: "Aino",
			org_id: 41,
			org_name: "Acme",
			matched_custom_field_values: ["Acme Oy"],
			matched_notes: ["Asked for renewal"],
			result_score: 0.98,
		},
	},
	{
		name: "persons",
		recordType: "person_search_hit",
		item: {
			id: 2,
			type: "person",
			name: "Aino Acme",
			phones: ["+358401234567"],
			emails: ["aino@example.invalid"],
			visible_to: 3,
			owner: { id: 11 },
			organization: { id: 41, name: "Acme" },
			custom_fields: ["VIP"],
			notes: ["Met at Slush"],
		},
		expected: {
			id: 2,
			owner_id: 11,
			org_id: 41,
			org_name: "Acme",
			matched_custom_field_values: ["VIP"],
			matched_notes: ["Met at Slush"],
			result_score: 0.98,
		},
	},
	{
		name: "organizations",
		recordType: "organization_search_hit",
		item: {
			id: 3,
			type: "organization",
			name: "Acme Oy",
			address: "Helsinki",
			visible_to: 3,
			owner: { id: 11 },
			custom_fields: ["Enterprise"],
			notes: ["Key account"],
		},
		expected: {
			id: 3,
			owner_id: 11,
			matched_custom_field_values: ["Enterprise"],
			matched_notes: ["Key account"],
			result_score: 0.98,
		},
	},
	{
		name: "products",
		recordType: "product_search_hit",
		item: {
			id: 4,
			type: "product",
			name: "Acme plan",
			code: 1004,
			visible_to: 3,
			owner: { id: 11 },
			custom_fields: ["Annual"],
		},
		expected: {
			id: 4,
			owner_id: 11,
			matched_custom_field_values: ["Annual"],
			result_score: 0.98,
		},
	},
];

const fixture = (
	entry: SearchCase,
	items: unknown[] = [{ result_score: 0.98, item: entry.item }],
	query: Record<string, string | number> = { limit: 500, term: "Acme" },
): Fixture => ({
	path: `/api/v2/${entry.name}/search`,
	query,
	body: {
		success: true,
		data: { items },
		additional_data: { next_cursor: null },
	},
});

const run = async (
	argv: readonly string[],
	fixtures?: readonly Fixture[],
	env: Record<string, string | undefined> = { PD_API_TOKEN: "test-token" },
	home = "/home/nobody",
) => {
	const out = capture();
	let dispatches = 0;
	const replay = fixtures === undefined ? undefined : createReplayTransport(fixtures);
	const exit = await route({
		argv,
		platform: "linux",
		env,
		home,
		...(replay === undefined
			? {}
			: {
					transport: (request: Request) => {
						dispatches += 1;
						return replay(request);
					},
				}),
		sink: out.sink,
		stderr: out.stderr,
	});
	return { exit, lines: out.lines(), dispatches };
};

const records = (lines: readonly Line[]): Line[] =>
	lines.filter((line) => line["type"] === "record");

describe("the search verb", () => {
	for (const entry of CASES) {
		test(`${entry.name} emits a flattened, distinctly tagged search hit`, async () => {
			const result = await run(
				[entry.name, "search", "Acme"],
				[fixture(entry)],
			);
			const hit = records(result.lines)[0] as Line;

			expect(result.exit).toBe(0);
			expect(hit).toMatchObject({
				type: "record",
				record_type: entry.recordType,
				...entry.expected,
			});
			expect(hit["record_type"]).not.toBe(entry.recordType.replace("_search_hit", ""));
			expect(hit).not.toHaveProperty("item");
			expect(hit).not.toHaveProperty("owner");
			expect(hit).not.toHaveProperty("custom_fields");
			expect(hit).not.toHaveProperty("notes");
		});
	}

	test("--fields projects the flattened hit like list, including API-supplied names", async () => {
		const entry = CASES[0] as SearchCase;
		const onlyId = await run(
			["deals", "search", "Acme", "--fields", "id"],
			[fixture(entry)],
		);
		expect(records(onlyId.lines)).toEqual([
			{ type: "record", record_type: "deal_search_hit", id: 1 },
		]);

		const suppliedName = await run(
			["deals", "search", "Acme", "--fields", "stage_name"],
			[fixture(entry)],
		);
		expect(records(suppliedName.lines)).toEqual([
			{
				type: "record",
				record_type: "deal_search_hit",
				id: 1,
				stage_name: "Qualified",
			},
		]);
	});

	test("search flags are command-scoped and sent under their API names", async () => {
		const entry = CASES[0] as SearchCase;
		const result = await run(
			[
				"deals",
				"search",
				"Acme",
				"--exact",
				"--search-in",
				"title,notes",
				"--person-id",
				"31",
				"--organization-id",
				"41",
				"--status",
				"open",
			],
			[
				fixture(entry, undefined, {
					exact_match: "true",
					fields: "title,notes",
					limit: 500,
					organization_id: 41,
					person_id: 31,
					status: "open",
					term: "Acme",
				}),
			],
		);

		expect(result.exit).toBe(0);
		expect(result.dispatches).toBe(1);
	});

	test("a one-character term is refused offline unless --exact is present", async () => {
		const refused = await run(["deals", "search", "A"]);
		expect(refused.exit).toBe(2);
		expect(refused.dispatches).toBe(0);
		expect(refused.lines.at(-1)?.["code"]).toBe("usage");

		const entry = CASES[0] as SearchCase;
		const accepted = await run(
			["deals", "search", "A", "--exact"],
			[
				fixture(entry, undefined, {
					exact_match: "true",
					limit: 500,
					term: "A",
				}),
			],
		);
		expect(accepted.exit).toBe(0);
	});

	for (const flag of ["--sort-by", "--sort-direction"] as const) {
		test(`${flag} is refused offline on search`, async () => {
			const value = flag === "--sort-by" ? "id" : "asc";
			const result = await run(["deals", "search", "Acme", flag, value]);
			expect(result.exit).toBe(2);
			expect(result.dispatches).toBe(0);
		});
	}

	test("search is not exposed for out-of-scope resources or endpoints", async () => {
		for (const argv of [
			["activities", "search", "Acme"],
			["leads", "search", "Acme"],
			["items", "search", "Acme"],
			["deals", "search", "Acme", "--search-for-related-items"],
		]) {
			const result = await run(argv);
			expect(result.exit).toBe(2);
			expect(result.dispatches).toBe(0);
		}
	});

	test("unknown fields in pd-owned hit schemas reject the hit rather than widening it", async () => {
		const entry = CASES[3] as SearchCase;
		const result = await run(
			["products", "search", "Acme"],
			[
				fixture(entry, [
					{
						result_score: 0.98,
						item: { ...entry.item, widened_upstream_field: true },
					},
				]),
			],
		);
		expect(result.exit).toBe(1);
		expect(result.lines.at(-1)).toMatchObject({
			type: "error",
			code: "invalid_response",
			emitted: 0,
		});
	});

	test("--limit 20 returns the twenty best matches from relevance order", async () => {
		const entry = CASES[0] as SearchCase;
		const items = Array.from({ length: 30 }, (_, index) => ({
			result_score: 1 - index / 100,
			item: { ...entry.item, id: index + 1 },
		}));
		const result = await run(
			["deals", "search", "Acme", "--limit", "20"],
			[fixture(entry, items)],
		);

		expect(records(result.lines).map((line) => line["id"])).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 1),
		);
		expect(result.lines.at(-1)).toMatchObject({
			type: "summary",
			complete: false,
			emitted: 20,
			reason: "limit",
			requests: 1,
		});
	});

	test("--resolve never dispatches metadata when the owner cache is cold", async () => {
		const root = await mkdtemp(join(tmpdir(), "pd-search-cold-"));
		const env = {
			PD_API_TOKEN: "test-token",
			XDG_CACHE_HOME: join(root, "cache"),
			XDG_CONFIG_HOME: join(root, "config"),
		};
		try {
			const entry = CASES[0] as SearchCase;
			const result = await run(
				["deals", "search", "Acme", "--resolve"],
				[fixture(entry)],
				env,
				root,
			);
			expect(result.exit).toBe(0);
			expect(result.dispatches).toBe(1);
			expect(records(result.lines)[0]).not.toHaveProperty("owner_name");
			expect(result.lines.at(-1)).toMatchObject({ resolved: "partial", requests: 1 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("--resolve reads owner names from cache without an extra dispatch", async () => {
		const root = await mkdtemp(join(tmpdir(), "pd-search-"));
		const env = {
			PD_API_TOKEN: "test-token",
			XDG_CACHE_HOME: join(root, "cache"),
			XDG_CONFIG_HOME: join(root, "config"),
		};
		try {
			const primed = await run(["users", "list"], [usersFixture([user(11)])], env, root);
			expect(primed.exit).toBe(0);

			const entry = CASES[0] as SearchCase;
			const result = await run(
				["deals", "search", "Acme", "--resolve"],
				[fixture(entry)],
				env,
				root,
			);
			expect(result.exit).toBe(0);
			expect(result.dispatches).toBe(1);
			expect(records(result.lines)[0]).toMatchObject({
				owner_id: 11,
				owner_name: "Aino Virtanen 11",
				stage_name: "Qualified",
				person_name: "Aino",
				org_name: "Acme",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
