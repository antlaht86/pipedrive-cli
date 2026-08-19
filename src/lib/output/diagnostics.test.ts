import { describe, expect, test } from "bun:test";

import { FakeClock } from "../../../test/support/clock.ts";
import { RunDiagnostics } from "./diagnostics.ts";
import type { Sink } from "./ndjson-writer.ts";
import { isStatusClear } from "../../../test/support/ndjson.ts";

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

/** The status line is the only write that opens with a carriage return. */
const statusLines = (output: readonly string[]): string[] =>
	output.filter((text) => text.startsWith("\rpd: "));

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

	/**
	 * Ticket 23. The gate-raise anomaly redraws the status line between the
	 * response arriving and the page's records being emitted, so that redraw
	 * pairs `0 records` with `1 requests` — which reads as "the walk returned
	 * nothing", the one thing a human watches the line to find out. Arriving
	 * records therefore schedule a redraw of their own.
	 *
	 * The two runs differ only in whether anything yields between the record and
	 * the trailer. Nothing does on a bounded single-page walk: `stream` writes the
	 * trailer in the same tick the page was emitted in, so the coalesced redraw
	 * never gets its turn and the finish path has to draw it.
	 */
	for (const yields of [true, false]) {
		test(`a run that ${yields ? "yields" : "never yields"} ends on an agreeing count`, async () => {
			const { diagnostics, output, request } = diagnosticsOf({ tty: true });
			request();
			diagnostics.anomaly(
				"rate-limit gate raised from 10 to 20 requests per window",
			);
			diagnostics.record();
			if (yields) await Promise.resolve();
			diagnostics.finish();

			expect(statusLines(output).at(-1)).toContain("1 records, 1 requests");
			expect(output.join("")).toContain("pd: finished: 1 records, 1 requests");
		});
	}

	/** ADR-0015 keeps the redraw off the per-record path: a page costs one. */
	test("a page of records costs one redraw, not one per record", async () => {
		const { diagnostics, output, request } = diagnosticsOf({ tty: true });
		request();
		for (let index = 0; index < 500; index += 1) diagnostics.record();
		await Promise.resolve();
		diagnostics.finish();

		expect(statusLines(output)).toHaveLength(1);
	});

	test("a machine run stays byte-silent when records arrive", async () => {
		const { diagnostics, output } = diagnosticsOf();
		diagnostics.record();
		await Promise.resolve();
		diagnostics.finish();
		expect(output.join("")).toBe("");
	});

	/**
	 * Ticket 24. `yieldLine` is called from the stdout writer on every line it
	 * writes, so it runs on a machine run too — where there is no status line to
	 * give back and stderr must stay byte-silent (ADR-0015 §1).
	 */
	test("yielding the line writes nothing on a machine run", () => {
		const { diagnostics, output } = diagnosticsOf();
		diagnostics.record();
		diagnostics.yieldLine();
		diagnostics.finish();
		expect(output.join("")).toBe("");
	});

	/** Nothing to give back before the first draw, and nothing after the last. */
	test("yielding the line is a no-op with no status line on screen", () => {
		const { diagnostics, output } = diagnosticsOf({ tty: true });
		diagnostics.yieldLine();
		expect(output).toEqual([]);

		diagnostics.refresh();
		diagnostics.yieldLine();
		diagnostics.yieldLine();
		expect(output.filter(isStatusClear)).toHaveLength(1);
	});

	test("the cache line is verbose-only, and a TTY alone does not earn it", () => {
		const tty = diagnosticsOf({ tty: true });
		tty.diagnostics.cacheServed("users");
		expect(tty.output.join("")).not.toContain("served from cache");

		const verbose = diagnosticsOf({ verbose: true });
		verbose.diagnostics.cacheServed("dealFields");
		expect(verbose.output.join("")).toContain(
			"pd: dealFields served from cache, no request\n",
		);

		// After the trailer nothing may be written — the same rule the request
		// line follows.
		verbose.diagnostics.finish();
		const settled = verbose.output.length;
		verbose.diagnostics.cacheServed("stages");
		expect(verbose.output).toHaveLength(settled);
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
			upstreamCacheHit: false,
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

	/**
	 * ADR-0015 §6 makes two refusals unconditional rather than allowlist
	 * membership: `term` is company data and `x-api-token` is the credential.
	 * Both are enforced by an explicit second guard, on top of the allowlists —
	 * and neither guard can be reached by a crafted request, because neither name
	 * is in an allowlist for it to override. The test above therefore passes with
	 * both guards deleted.
	 *
	 * So the guards are asserted against the source, the way
	 * `test/generated-read-only.test.ts` asserts the read-only property: what is
	 * being protected is a defence that a refactor would otherwise remove as dead
	 * code, and its whole purpose is to survive the edit that makes it live.
	 */
	test("the term and credential refusals do not rest on the allowlists", async () => {
		const source = await Bun.file("src/lib/output/diagnostics.ts").text();

		expect(source).toContain('name !== "term"');
		expect(source).toContain('name === "x-api-token"');
	});
});
