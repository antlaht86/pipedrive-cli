import { describe, expect, test } from "bun:test";

import { FakeClock } from "../../../test/support/clock.ts";
import { RunDiagnostics } from "./diagnostics.ts";
import type { Sink } from "./ndjson-writer.ts";

const diagnosticsOf = ({
	tty = false,
	verbose = false,
}: {
	tty?: boolean;
	verbose?: boolean;
} = {}) => {
	const output: string[] = [];
	const clock = new FakeClock();
	let requests = 0;
	const diagnostics = new RunDiagnostics({
		sink: ((text) => output.push(text)) satisfies Sink,
		isTty: () => tty,
		verbose,
		clock,
		requests: () => requests,
		pacing: () => ({ defaultLimit: 10, searchLimit: 5, concurrency: 4 }),
	});
	return {
		clock,
		diagnostics,
		output,
		request: () => {
			requests += 1;
		},
	};
};

describe("run diagnostics", () => {
	test("a bounded successful machine run is byte-silent", () => {
		const { diagnostics, output } = diagnosticsOf();
		diagnostics.record();
		diagnostics.finish();
		expect(output.join("")).toBe("");
	});

	test("a TTY timer rewrites progress at roughly 1 Hz", async () => {
		const { clock, diagnostics, output, request } = diagnosticsOf({
			tty: true,
		});
		diagnostics.record();
		request();
		clock.advance(1_000);

		await new Promise((resolve) => setTimeout(resolve, 1_050));
		diagnostics.anomaly("gate paused for 2s");
		clock.advance(250);
		diagnostics.finish();

		const text = output.join("");
		expect(text).toContain("\rpd: 1 records, 1 requests, 1.0s");
		expect(text).toContain("gate 10/5 per 2s, concurrency 4");
		expect(text).toContain("gate paused for 2s\n");
		expect(text).toContain("pd: finished: 1 records, 1 requests, 1.3s\n");
		expect(text).not.toContain("token");
	});

	test("verbose request lines redact query values and headers by allowlist", () => {
		const { diagnostics, output } = diagnosticsOf({ verbose: true });
		diagnostics.request({
			request: new Request(
				"https://api.pipedrive.com/api/v2/deals/42?limit=100&term=Acme%20Secret&future=private&ids=1,2",
				{
					headers: {
						"x-api-token": "credential-secret",
						"x-private": "private-header",
					},
				},
			),
			response: new Response("crm-response-secret", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "99",
					"x-private": "response-private",
					"x-api-token": "response-token",
				},
			}),
			durationMs: 25,
			attempt: 1,
			cacheHit: false,
		});
		diagnostics.finish();

		const text = output.join("");
		expect(text).toContain("GET /api/v2/deals/42");
		expect(text).toContain("limit=100");
		expect(text).toContain("ids=1,2");
		expect(text).toContain("term=[redacted]");
		expect(text).toContain("future=[redacted]");
		expect(text).toContain("content-type=application/json");
		expect(text).toContain("x-ratelimit-remaining=99");
		for (const secret of [
			"Acme Secret",
			"private",
			"credential-secret",
			"private-header",
			"response-private",
			"response-token",
			"crm-response-secret",
		]) {
			expect(text).not.toContain(secret);
		}
	});
});
