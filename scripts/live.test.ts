import { describe, expect, test } from "bun:test";

import { errAsync, ok, okAsync } from "neverthrow";

import { PdFailure } from "../src/lib/pipedrive/failure.ts";
import {
	classifyCommand,
	completeRecording,
	createRecordingTransport,
	parseLiveArguments,
} from "./live.ts";
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

	test("continues, writes, and succeeds when one command detects drift", async () => {
		const recorded: RecordedFixture[] = [];
		let command = 0;
		let persisted = false;
		const result = await completeRecording(
			[["deals", "list"], ["persons", "list"]],
			recorded,
			() => {
				command += 1;
				recorded.push({
					method: "GET",
					path: command === 1 ? "/api/v2/deals" : "/api/v2/persons",
					query: {},
					status: 200,
					body: command === 1 ? { changed_shape: true } : { data: [] },
				});
				return command === 1
					? okAsync({ kind: "failure" as const, exit: 1 as const, recordableDrift: true })
					: okAsync({ kind: "success" as const, exit: 0 as const });
			},
			() => {
				persisted = true;
				return ok(undefined);
			},
		);
		expect(result.isOk() ? result.value : undefined).toBe(0);
		expect(command).toBe(2);
		expect(persisted).toBe(true);
	});

	test("does not erase fixtures when a command fails before any response", async () => {
		let persisted = false;
		const result = await completeRecording(
			[["deals", "list"]],
			[],
			() => errAsync("auth failed"),
			() => {
				persisted = true;
				return ok(undefined);
			},
		);
		expect(result.isErr()).toBe(true);
		expect(persisted).toBe(false);
	});

	test("does not turn an authentication response into fixture drift", async () => {
		const recorded: RecordedFixture[] = [];
		let persisted = false;
		const result = await completeRecording(
			[["deals", "list"]],
			recorded,
			() => {
				recorded.push({
					method: "GET",
					path: "/api/v2/deals",
					query: {},
					status: 401,
					body: { success: false },
				});
				return okAsync({
					kind: "failure" as const,
					exit: 1 as const,
					recordableDrift: false,
				});
			},
			() => {
				persisted = true;
				return ok(undefined);
			},
		);
		expect(result.isOk() ? result.value : undefined).toBe(1);
		expect(persisted).toBe(false);
	});

	test("does not persist an earlier prefix when the failing command got no response", async () => {
		const recorded: RecordedFixture[] = [];
		let command = 0;
		let persisted = false;
		const result = await completeRecording(
			[["deals", "list"], ["persons", "list"]],
			recorded,
			() => {
				command += 1;
				if (command === 1) {
					recorded.push({
						method: "GET",
						path: "/api/v2/deals",
						query: {},
						status: 200,
						body: { data: [] },
					});
					return okAsync({ kind: "success" as const, exit: 0 as const });
				}
				return okAsync({
					kind: "failure" as const,
					exit: 3 as const,
					recordableDrift: false,
				});
			},
			() => {
				persisted = true;
				return ok(undefined);
			},
		);
		expect(result.isOk() ? result.value : undefined).toBe(3);
		expect(persisted).toBe(false);
	});
});

describe("live command failure classification", () => {
	const trailer = (code: "internal" | "request_ceiling", exitCode: 1 | 3) =>
		`${JSON.stringify({
			type: "error",
			code,
			message: "changed",
			exit_code: exitCode,
			retry: "never",
			complete: false,
			emitted: 0,
			skipped: 0,
			duplicates: 0,
			resolved: "off",
			requests: 1,
		})}\n`;

	test("treats a response-backed internal error as drift", () => {
		expect(classifyCommand(1, trailer("internal", 1))).toEqual(
			ok({ kind: "failure", exit: 1, recordableDrift: true }),
		);
	});

	test("requires the final trailer and matching process exit", () => {
		expect(
			classifyCommand(1, `${trailer("internal", 1)}{"type":"warning"}\n`).isErr(),
		).toBe(true);
		expect(classifyCommand(1, trailer("request_ceiling", 3)).isErr()).toBe(
			true,
		);
	});
});

describe("live command arguments", () => {
	test("parses the complete argument vector", () => {
		expect(parseLiveArguments([]).unwrapOr("bad")).toBe("an");
		expect(parseLiveArguments(["acme"]).unwrapOr("bad")).toBe("acme");
		expect(parseLiveArguments(["acme", "extra"]).isErr()).toBe(true);
	});
});
