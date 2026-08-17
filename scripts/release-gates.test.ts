import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	FIXTURE_CANARY,
	binaryContainsFixture,
	credentialLeak,
	expectedCredentialPath,
	fixtureCredentialGate,
	fixtureDocument,
	parseGateArguments,
} from "./release-gates.ts";

describe("the fixture credential gate", () => {
	test("rejects credential-bearing request metadata", () => {
		expect(credentialLeak('{"x-api-token":"secret"}')).toContain("x-api-token");
		expect(credentialLeak('{"Authorization":"Bearer secret"}')).toContain(
			"Authorization",
		);
		expect(credentialLeak('{"PD_API_TOKEN":"secret"}')).toContain(
			"PD_API_TOKEN",
		);
	});

	test("rejects a raw token value without credential metadata", () => {
		const token = "0123456789abcdef0123456789abcdef01234567";
		expect(credentialLeak(`{"leaked":"${token}"}`)).toBe(token);
		expect(credentialLeak(`{"leaked":"prefix-${token}-suffix"}`)).toBe(token);
		expect(credentialLeak(`{"key":"${token}"}`)).toBe(token);
		expect(credentialLeak(`plain text ${token}`)).toBe(token);
		expect(credentialLeak(`prefix${token}suffix`)).toBeDefined();
		expect(credentialLeak(`{"${token}":"value"}`)).toBe(token);
	});

	test("allows only hashes established by a real field-schema fixture", () => {
		const hash = "40f2b01bd78f65e9365d218ad6f8a95a2d581234";
		const token = "0123456789abcdef0123456789abcdef01234567";
		expect(credentialLeak(`{"key":"${hash}"}`)).toBe(hash);
		expect(
			credentialLeak(`{"value":"${hash} ${token}"}`, new Set([hash])),
		).toBe(token);

		const root = mkdtempSync(join(tmpdir(), "pd-fixture-gate-test-"));
		const document = fixtureDocument([
			{
				method: "GET",
				path: "/api/v2/dealFields",
				query: {},
				status: 200,
				body: {
					success: true,
					data: [
						{
							field_code: hash,
							field_name: "Renewal",
							field_type: "varchar",
							is_custom_field: true,
						},
					],
				},
			},
			{
				method: "GET",
				path: "/api/v2/deals",
				query: {},
				status: 200,
				body: { data: [{ custom_fields: { [hash]: "value" } }] },
			},
		]);
		writeFileSync(join(root, "responses.json"), JSON.stringify(document));
		expect(fixtureCredentialGate(root).isOk()).toBe(true);
		rmSync(root, { recursive: true, force: true });
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

	test("detects exact UTF-8 fixture content without relying only on the canary", () => {
		const document = fixtureDocument([
			{
				method: "GET",
				path: "/api/v2/deals",
				query: {},
				status: 200,
				body: { id: 7, title: "Äänekosken Oy" },
			},
		]);
		const raw = JSON.stringify(document.fixtures[0]?.body);
		const embedded = binaryContainsFixture(Buffer.from(`prefix${raw}suffix`), {
			documents: [],
			rawContents: [Buffer.from(raw)],
		});
		expect(embedded.isOk() ? embedded.value : undefined).toBe(
			"raw fixture file",
		);
	});
});

describe("artifact gate arguments and platform paths", () => {
	test("rejects extra gate arguments", () => {
		expect(parseGateArguments([]).isOk()).toBe(true);
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
