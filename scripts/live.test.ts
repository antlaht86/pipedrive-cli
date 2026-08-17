import { describe, expect, test } from "bun:test";

import { PdFailure } from "../src/lib/pipedrive/failure.ts";
import { createRecordingTransport } from "./live.ts";
import type { RecordedFixture } from "./release-gates.ts";

const request = (method = "GET") =>
	new Request("https://api.pipedrive.com/api/v2/deals?limit=20", {
		method,
		headers: { "x-api-token": "must-never-be-recorded" },
	});

describe("the hand-invoked live recorder", () => {
	test("records a successful body and no request headers", async () => {
		const recorded: RecordedFixture[] = [];
		const transport = createRecordingTransport({
			recorded,
			maxRequests: 3,
			upstream: () =>
				Promise.resolve(
					new Response('{"success":true,"data":[]}', { status: 200 }),
				),
		});

		const response = await transport(request());
		expect(await response.json()).toEqual({ success: true, data: [] });
		expect(recorded).toEqual([
			{
				method: "GET",
				path: "/api/v2/deals",
				query: { limit: "20" },
				status: 200,
				body: { success: true, data: [] },
			},
		]);
		expect(JSON.stringify(recorded)).not.toContain("must-never-be-recorded");
	});

	test("refuses non-GET and retry-provoking responses", async () => {
		let dispatches = 0;
		const recorded: RecordedFixture[] = [];
		const transport = createRecordingTransport({
			recorded,
			maxRequests: 3,
			upstream: () => {
				dispatches += 1;
				return Promise.resolve(new Response(null, { status: 500 }));
			},
		});

		const write = await transport(request("POST")).catch((cause) => cause);
		expect(write).toBeInstanceOf(PdFailure);
		expect(dispatches).toBe(0);

		const retry = await transport(request()).catch((cause) => cause);
		expect(retry).toBeInstanceOf(PdFailure);
		expect(dispatches).toBe(1);
		expect(recorded).toEqual([]);
	});

	test("enforces one ceiling across all live commands", async () => {
		const transport = createRecordingTransport({
			recorded: [],
			maxRequests: 1,
			upstream: () => Promise.resolve(new Response("{}")),
		});
		await transport(request());
		const refusal = await transport(request()).catch((cause) => cause);
		expect(refusal).toBeInstanceOf(PdFailure);
	});
});
