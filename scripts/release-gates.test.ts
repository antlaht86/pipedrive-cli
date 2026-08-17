import { describe, expect, test } from "bun:test";

import {
	FIXTURE_CANARY,
	credentialLeak,
	fixtureDocument,
} from "./release-gates.ts";

describe("the fixture credential gate", () => {
	test("rejects credential-bearing request metadata", () => {
		expect(credentialLeak('{"x-api-token":"secret"}')).toContain(
			"x-api-token",
		);
		expect(credentialLeak('{"Authorization":"Bearer secret"}')).toContain(
			"Authorization",
		);
		expect(credentialLeak('{"PD_API_TOKEN":"secret"}')).toContain(
			"PD_API_TOKEN",
		);
	});

	test("does not mistake a custom-field hash for a credential", () => {
		expect(
			credentialLeak(
				'{"40f2b01bd78f65e9365d218ad6f8a95a2d581234":"customer value"}',
			),
		).toBeUndefined();
	});
});

describe("live fixture documents", () => {
	test("carry the binary-exclusion canary and never request headers", () => {
		const document = fixtureDocument([
			{
				method: "GET",
				path: "/api/v2/deals",
				query: { limit: 20 },
				status: 200,
				body: { data: [] },
			},
		]);

		expect(document.canary).toBe(FIXTURE_CANARY);
		expect(JSON.stringify(document)).not.toContain("headers");
	});
});
