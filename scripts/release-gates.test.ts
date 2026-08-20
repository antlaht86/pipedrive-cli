import { describe, expect, test } from "bun:test";

import {
	FIXTURE_CANARY,
	binaryEmbedsRecording,
	expectedCredentialPath,
	fixtureDocument,
	parseGateArguments,
} from "./release-gates.ts";

describe("the binary-exclusion gate", () => {
	test("carries the canary into every recording", () => {
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
	});

	test("fails a binary that embeds a recording", () => {
		const document = fixtureDocument([
			{
				method: "GET",
				path: "/api/v2/deals",
				query: {},
				status: 200,
				body: { id: 7, title: "Äänekosken Oy" },
			},
		]);
		const embedded = Buffer.from(
			`ELFprefix${JSON.stringify(document)}suffix`,
			"utf8",
		);

		expect(binaryEmbedsRecording(embedded)).toBe(true);
	});

	test("passes a binary that embeds no recording", () => {
		const clean = Buffer.from("ELFprefix pd 1.0.0 suffix", "utf8");

		expect(binaryEmbedsRecording(clean)).toBe(false);
	});
});

describe("artifact gate arguments and platform paths", () => {
	test("requires exactly one binary path", () => {
		expect(parseGateArguments([]).isErr()).toBe(true);
		expect(parseGateArguments(["dist/pd"]).isOk()).toBe(true);
		expect(parseGateArguments(["dist/pd", "extra"]).isErr()).toBe(true);
	});

	test("chooses the platform-native credential path", () => {
		expect(
			expectedCredentialPath("win32", {
				xdg: "/tmp/xdg",
				appData: "C:\\AppData",
			}),
		).toBe("C:\\AppData\\pd\\credentials");
		expect(
			expectedCredentialPath("linux", {
				xdg: "/tmp/xdg",
				appData: "/tmp/appdata",
			}),
		).toBe("/tmp/xdg/pd/credentials");
	});
});
