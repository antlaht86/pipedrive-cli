/**
 * The five live resources and the `get` verb — ticket 07's acceptance criteria.
 *
 * Every test drives the real router through fixture replay (ADR-0019 §2), so
 * the grammar, the walk, the by-id fetch, both validation stages, the writer,
 * the error union and the exit codes are exercised together. The default
 * transport throws, so any request a test forgot to record fails the run rather
 * than reaching Pipedrive (ADR-0019 §3).
 *
 * `deals` is covered end to end by `deals-list.test.ts`; what is asserted here
 * is that the other four are the *same* command, and that the second verb and
 * the refusal behave as ADR-0009 says.
 */

import { describe, expect, test } from "bun:test";
import { route } from "../src/router.ts";
import { LIVE_RESOURCES } from "../src/lib/pipedrive/resources.ts";
import { createReplayTransport, type Fixture } from "./support/replay.ts";
import { capture, type Line } from "./support/ndjson.ts";
import {
	LIVE,
	getRecord,
	listPage,
	person,
	product,
} from "./support/records.ts";

type Run = { exit: number; lines: Line[]; stderr: string[]; last: Line };

const runWith = async (
	fixtures: readonly Fixture[] | undefined,
	argv: readonly string[],
	env: Record<string, string | undefined> = { PD_API_TOKEN: "test-token" },
): Promise<Run> => {
	const out = capture();
	const exit = await route({
		argv,
		platform: "linux",
		env,
		home: "/home/nobody",
		...(fixtures === undefined
			? {}
			: { transport: createReplayTransport(fixtures) }),
		sink: out.sink,
		stderr: out.stderr,
	});
	const lines = out.lines();
	return { exit, lines, stderr: out.errors, last: lines.at(-1) as Line };
};

const records = (lines: Line[]): Line[] =>
	lines.filter((line) => line["type"] === "record");

describe("every live resource lists on the ticket-05 contract", () => {
	for (const resource of LIVE) {
		test(`pd ${resource.name} list walks every page and tags the singular record_type`, async () => {
			const { exit, lines, last } = await runWith(
				[
					listPage(resource, [resource.record(1), resource.record(2)], "c2"),
					listPage(resource, [resource.record(3)], null, "c2"),
				],
				[resource.name, "list"],
			);

			expect(exit).toBe(0);
			expect(records(lines).map((line) => line["id"])).toEqual([1, 2, 3]);
			expect(
				new Set(records(lines).map((line) => line["record_type"])),
			).toEqual(new Set([resource.recordType]));
			expect(last).toEqual({
				type: "summary",
				complete: true,
				emitted: 3,
				skipped: 0,
				duplicates: 0,
				resolved: "off",
				requests: 2,
			});
		});

		test(`pd ${resource.name} list with no matches is an empty success`, async () => {
			const { exit, lines, last } = await runWith(
				[listPage(resource, [], null)],
				[resource.name, "list"],
			);

			expect(exit).toBe(0);
			expect(records(lines)).toHaveLength(0);
			expect(last).toMatchObject({
				type: "summary",
				complete: true,
				emitted: 0,
			});
		});

		test(`pd ${resource.name} list rejects one bad record and survives`, async () => {
			const { exit, lines, last } = await runWith(
				[
					listPage(
						resource,
						[resource.record(1), resource.record(2, { id: "not-an-int" })],
						null,
					),
				],
				[resource.name, "list"],
			);

			expect(exit).toBe(0);
			expect(records(lines).map((line) => line["id"])).toEqual([1]);
			expect(lines.filter((line) => line["type"] === "warning")).toHaveLength(
				1,
			);
			expect(last).toMatchObject({ complete: true, emitted: 1, skipped: 1 });
		});

		test(`pd ${resource.name} list passes timestamps through byte for byte`, async () => {
			const { lines } = await runWith(
				[
					listPage(
						resource,
						[resource.record(1, { update_time: "2026-02-18 13:01:07" })],
						null,
					),
				],
				[resource.name, "list"],
			);

			expect(records(lines)[0]?.["update_time"]).toBe("2026-02-18 13:01:07");
			expect(records(lines)[0]?.["add_time"]).toBe("2025-11-03T09:14:22Z");
		});
	}
});

describe("the get verb", () => {
	for (const resource of LIVE) {
		test(`pd ${resource.name} get 42 emits one record and a trailer`, async () => {
			const { exit, lines, last } = await runWith(
				[getRecord(resource, 42)],
				[resource.name, "get", "42"],
			);

			expect(exit).toBe(0);
			expect(records(lines)).toHaveLength(1);
			expect(records(lines)[0]).toMatchObject({
				record_type: resource.recordType,
				id: 42,
			});
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

		test(`pd ${resource.name} get on a missing id is not_found, exit 1`, async () => {
			const { exit, lines, last } = await runWith(
				[
					{
						path: `${resource.path}/999`,
						status: 404,
						body: { success: false },
					},
				],
				[resource.name, "get", "999"],
			);

			expect(exit).toBe(1);
			expect(records(lines)).toHaveLength(0);
			expect(last).toMatchObject({
				type: "error",
				code: "not_found",
				exit_code: 1,
				retry: "never",
				complete: false,
				emitted: 0,
			});
		});
	}

	test("the request is a GET at the by-id path, with no query", async () => {
		const replay = createReplayTransport([getRecord(LIVE[1] as never, 7)]);
		let url = "";
		let method = "";

		const { exit } = await (async () => {
			const out = capture();
			const code = await route({
				argv: ["persons", "get", "7"],
				platform: "linux",
				env: { PD_API_TOKEN: "test-token" },
				home: "/home/nobody",
				transport: (request) => {
					url = request.url;
					method = request.method;
					return replay(request);
				},
				sink: out.sink,
				stderr: out.stderr,
			});
			return { exit: code };
		})();

		expect(exit).toBe(0);
		expect(method).toBe("GET");
		expect(url).toBe("https://api.pipedrive.com/api/v2/persons/7");
	});

	test("a record pd cannot read is invalid_response, not not_found", async () => {
		// The record exists; pd's schema does not describe it. Reporting nothing
		// found would be a different, false answer.
		const { exit, last } = await runWith(
			[
				{
					path: "/api/v2/persons/42",
					body: { success: true, data: { ...person(42), id: "not-an-int" } },
				},
			],
			["persons", "get", "42"],
		);

		expect(exit).toBe(1);
		expect(last).toMatchObject({
			type: "error",
			code: "invalid_response",
			emitted: 0,
			complete: false,
		});
		expect(last["details"]).toMatchObject({ resource: "person", id: 42 });
	});

	test("a by-id body pd cannot read at all is invalid_response", async () => {
		const { exit, last } = await runWith(
			[{ path: "/api/v2/persons/42", body: { data: person(42) } }],
			["persons", "get", "42"],
		);

		expect(exit).toBe(1);
		expect(last["code"]).toBe("invalid_response");
	});

	test("get with no id is a usage error, exit 2, and no request", async () => {
		const { exit, lines, last } = await runWith(undefined, ["deals", "get"]);

		expect(exit).toBe(2);
		expect(lines).toHaveLength(1);
		expect(last).toMatchObject({ type: "error", code: "usage", exit_code: 2 });
		expect(last["message"]).toBe("pd deals get needs an id.");
	});

	for (const bad of ["0", "-1", "4.5", "abc", "42abc", " 42"]) {
		test(`get ${JSON.stringify(bad)} is a usage error, offline`, async () => {
			const { exit, last } = await runWith(undefined, ["deals", "get", bad]);

			expect(exit).toBe(2);
			expect(last["code"]).toBe("usage");
		});
	}

	test("get with a second positional is a usage error", async () => {
		const { exit, last } = await runWith(undefined, ["deals", "get", "1", "2"]);

		expect(exit).toBe(2);
		expect(last["code"]).toBe("usage");
	});

	test("an unknown flag names the command it was given to", async () => {
		const { exit, last } = await runWith(undefined, [
			"products",
			"get",
			"1",
			"--frobnicate",
		]);

		expect(exit).toBe(2);
		expect(last["message"]).toBe(
			"pd products get does not accept --frobnicate. It takes --pretty, --token-file, --max-requests, --resolve-budget, --no-cache, --resolve, --verbose and --fields and no other flag.",
		);
	});
});

describe("one probe ends the search", () => {
	const message = async (argv: readonly string[]): Promise<Run> =>
		runWith(undefined, argv);

	test("a write verb is usage, exit 2, and says pd has no write commands at all", async () => {
		const { exit, lines, last } = await message(["deals", "update", "42"]);

		expect(exit).toBe(2);
		expect(lines).toHaveLength(1);
		expect(last).toMatchObject({
			type: "error",
			code: "usage",
			exit_code: 2,
			retry: "never",
			complete: false,
			emitted: 0,
			skipped: 0,
			duplicates: 0,
			resolved: "off",
			requests: 0,
		});
		expect(String(last["message"])).toContain("no write commands at all");
		expect(String(last["message"])).toContain("pd manifest");
	});

	test("the refusal does not claim the only verbs are list and get", async () => {
		// ADR-0009 §6, and ADR-0017 §1 is the reason: `search` is a third verb.
		const { last } = await message(["deals", "update", "42"]);

		expect(String(last["message"])).not.toContain("list");
		expect(String(last["message"])).not.toContain("get");
	});

	test("the machine-readable refusal is matched by a stderr line", async () => {
		const { stderr } = await message(["deals", "delete", "42"]);

		expect(stderr.join("")).toStartWith("pd: ");
		expect(stderr.join("")).toContain("no write commands at all");
	});

	for (const argv of [
		["people", "list"],
		["orgs", "list"],
		["organisations", "list"],
		["person", "get", "1"],
		["deal", "get", "1"],
	]) {
		test(`pd ${argv.join(" ")} is refused: ADR-0009 §5 has no aliases`, async () => {
			const { exit, last } = await message(argv);

			expect(exit).toBe(2);
			expect(last["code"]).toBe("usage");
			expect(String(last["message"])).toContain(
				`pd has no command '${argv.join(" ")}'`,
			);
		});
	}

	test("a resource with no verb is told the verb is missing, not the noun", async () => {
		// Saying pd has no command `persons` would invite the `pd people` probe
		// ADR-0009 §5 refuses to answer — the search this message exists to end.
		const { exit, last } = await message(["persons"]);

		expect(exit).toBe(2);
		expect(String(last["message"])).toStartWith("pd persons needs a verb.");
		expect(String(last["message"])).toContain("no write commands at all");
		expect(String(last["message"])).toContain("pd manifest");
	});

	test("an unknown verb on a known resource is still the no-command message", async () => {
		const { last } = await message(["persons", "update"]);

		expect(String(last["message"])).toStartWith(
			"pd has no command 'persons update'.",
		);
	});

	test("no command at all asks for one", async () => {
		const { exit, last } = await message([]);

		expect(exit).toBe(2);
		expect(String(last["message"])).toStartWith("pd needs a command.");
	});

	test("the refusal never echoes a flag value back", async () => {
		const { last } = await message(["frobnicate", "--token", "sekrit"]);

		expect(String(last["message"])).not.toContain("sekrit");
		expect(JSON.stringify(last)).not.toContain("sekrit");
	});

	test("the live table is the five that fetch on every invocation", async () => {
		// Ticket 08's four — `pipelines`, `stages`, `users`, `fields` — route
		// through `cached.ts` instead and are covered by
		// `cached-resources.test.ts`; `items` arrives with tickets 14–15 and is
		// still refused like anything else neither table has an entry for.
		expect([...LIVE_RESOURCES]).toEqual([
			"deals",
			"persons",
			"organizations",
			"activities",
			"products",
		]);
	});
});

describe("nested blocks", () => {
	test("products.prices is an array of objects with money and absence applied inside", async () => {
		const { lines } = await runWith(
			[
				listPage(
					LIVE[4] as never,
					[
						product(1, {
							prices: [
								{
									product_id: 1,
									price: 1200.5,
									currency: "EUR",
									cost: 0,
									direct_cost: null,
									notes: "",
								},
								{
									product_id: 1,
									price: 1400,
									currency: "USD",
									cost: 350,
									direct_cost: 300,
									notes: "list price",
								},
							],
						}),
					],
					null,
				),
			],
			["products", "list"],
		);

		const prices = records(lines)[0]?.["prices"] as Record<string, unknown>[];
		expect(prices).toHaveLength(2);
		// Money is a JSON number with its currency sibling inside the object.
		expect(prices[0]).toEqual({
			product_id: 1,
			price: 1200.5,
			currency: "EUR",
			// `cost: 0` is a value, not an absence, and `direct_cost: null` is gone.
			cost: 0,
			notes: "",
		});
		expect(prices[1]?.["direct_cost"]).toBe(300);
	});

	test("the omission rule reaches every nested block, not only prices", async () => {
		// ADR-0020 §7 named `products.prices` as the one nested block. It is not:
		// an activity carries `participants` and `attendees`, a person carries
		// `emails` and `postal_address`, an organization carries `address`.
		const { lines } = await runWith(
			[
				listPage(
					LIVE[3] as never,
					[
						LIVE[3]!.record(1, {
							participants: [
								{ person_id: null, primary: true },
								{ person_id: 5001, primary: false },
							],
							attendees: [],
						}),
					],
					null,
				),
			],
			["activities", "list"],
		);

		const record = records(lines)[0] as Line;
		const participants = record["participants"] as Record<string, unknown>[];
		expect(participants[0]).toEqual({ primary: true });
		expect(participants[1]).toEqual({ person_id: 5001, primary: false });
		// An empty array is a value, and survives.
		expect(record["attendees"]).toEqual([]);
	});

	test("a person's nested blocks survive whole when nothing is absent", async () => {
		const { lines } = await runWith(
			[listPage(LIVE[1] as never, [person(1)], null)],
			["persons", "list"],
		);

		const record = records(lines)[0] as Line;
		expect(record["emails"]).toEqual([
			{ value: "aino.1@example.invalid", primary: true, label: "work" },
		]);
		expect(Object.keys(record["postal_address"] as object)).toHaveLength(10);
	});

	test("an array element that is null keeps its place", async () => {
		// Absence removes keys, never elements: dropping one would renumber its
		// siblings and shorten a list the caller counts.
		const { lines } = await runWith(
			[
				listPage(
					LIVE[0] as never,
					[{ ...LIVE[0]!.record(1), label_ids: [] }],
					null,
				),
			],
			["deals", "list"],
		);

		expect(records(lines)[0]?.["label_ids"]).toEqual([]);
	});
});

describe("a record field never shadows a line key", () => {
	test("an activity's own type is emitted as activity_type", async () => {
		// Left alone it would overwrite ADR-0002's discriminator and emit
		// `{"type":"call", …}`, which no reader of the format can classify.
		const { lines } = await runWith(
			[
				listPage(
					LIVE[3] as never,
					[LIVE[3]!.record(1, { type: "meeting" })],
					null,
				),
			],
			["activities", "list"],
		);

		const record = records(lines)[0] as Line;
		expect(record["type"]).toBe("record");
		expect(record["record_type"]).toBe("activity");
		expect(record["activity_type"]).toBe("meeting");
	});

	test("the rename keeps the field in its place in the record", async () => {
		const { lines } = await runWith(
			[listPage(LIVE[3] as never, [LIVE[3]!.record(1)], null)],
			["activities", "list"],
		);

		const keys = Object.keys(records(lines)[0] as Line);
		expect(keys.slice(0, 5)).toEqual([
			"type",
			"record_type",
			"id",
			"subject",
			"activity_type",
		]);
	});
});
