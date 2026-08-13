import { describe, expect, test } from "bun:test";

import { FakeClock } from "../../../test/support/clock.ts";
import { createReplayTransport } from "../../../test/support/replay.ts";
import type { Fixture } from "../../../test/support/replay.ts";
import { client as v2Client } from "./v2/generated/client.gen.ts";
import {
  createGuardedFetch,
  redactUrl,
  throwingTransport,
  PIPEDRIVE_V2_BASE_URL,
} from "./guarded-fetch.ts";
import type { Transport } from "./guarded-fetch.ts";
import { PdFailure } from "./failure.ts";

/**
 * Ticket 04. No command uses `guardedFetch` yet, so these tests are the whole
 * verification of it — and ADR-0019 §9 makes them the *only* verification the
 * retry, 429 and Cloudflare paths will ever get, permanently. The live suite
 * never provokes a failure, because the successful execution of that test is
 * what costs the company its API access.
 *
 * This file lives beside the module rather than under `test/` because it drives
 * a non-GET through the generated client, and ESLint layer (c) confines that
 * import to `src/lib/pipedrive/**`.
 */

const url = (path: string): string => `${PIPEDRIVE_V2_BASE_URL}${path}`;

/** Every rejection out of `guardedFetch` is a `PdFailure`, or the test is wrong. */
const failureOf = async (promise: Promise<unknown>) => {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(PdFailure);
  return (caught as PdFailure).error;
};

const ok: Fixture = { path: "/api/v2/deals", body: { data: [] } };

describe("read-only layer (b): the non-GET refusal", () => {
  test("a non-GET driven through the generated client yields write_blocked, and dispatches nothing", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([ok]),
    });

    // Research 06 §1.5's hole, used deliberately: `...options` is spread after
    // `url`, so a wrapper bug can hand the runtime a request layer (a) never
    // saw. This is exactly the request layer (b) exists to catch.
    const result = await v2Client.post({
      url: "/deals",
      fetch: guard.fetch,
      baseUrl: PIPEDRIVE_V2_BASE_URL,
    });

    expect(result.error).toBeInstanceOf(PdFailure);
    const error = (result.error as PdFailure).error;
    expect(error.code).toBe("write_blocked");
    expect(error.exit_code).toBe(1);
    expect(error.retry).toBe("never");
    expect(error.message).toContain("bug in pd");
    expect(error.details).toEqual({ method: "POST", path: "/api/v2/deals" });

    // ADR-0013 §5: the refusal happened instead of the request, not after it.
    expect(guard.dispatches()).toBe(0);
  });

  test("every non-GET method is refused, and a GET is not", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([ok]),
    });

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const error = await failureOf(guard.fetch(url("/deals"), { method }));
      expect(error.code).toBe("write_blocked");
      expect(error.details).toMatchObject({ method });
    }
    expect(guard.dispatches()).toBe(0);

    expect((await guard.fetch(url("/deals"))).status).toBe(200);
    expect(guard.dispatches()).toBe(1);
  });

  test("the refused path carries no query string into details", async () => {
    const guard = createGuardedFetch({ clock: new FakeClock() });
    const error = await failureOf(
      guard.fetch(url("/deals?term=acme%20holdings&limit=500"), {
        method: "DELETE",
      }),
    );
    expect(error.details).toEqual({ method: "DELETE", path: "/api/v2/deals" });
  });
});

describe("redactUrl", () => {
  test("keeps the path and drops the query, which is company data", () => {
    expect(redactUrl("https://api.pipedrive.com/api/v2/deals?term=secret")).toBe(
      "/api/v2/deals",
    );
  });

  test("never throws on something that is not a URL", () => {
    expect(redactUrl("not a url")).toBe("<unparseable url>");
  });
});

describe("the burst gate", () => {
  test("holds 10 requests per rolling 2 seconds by default", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([ok]),
    });
    expect(guard.limitOf("default")).toBe(10);

    await Promise.all(
      Array.from({ length: 12 }, () => guard.fetch(url("/deals"))),
    );

    expect(guard.dispatches()).toBe(12);
    // Ten went at once; the eleventh and twelfth waited for the window to roll.
    expect(clock.now()).toBe(2_000);
  });

  test("raises to half of an observed x-ratelimit-limit, and never lowers", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        { path: "/api/v2/ultimate", headers: { "x-ratelimit-limit": "120" } },
        { path: "/api/v2/lite", headers: { "x-ratelimit-limit": "20" } },
        { path: "/api/v2/silent" },
      ]),
    });

    await guard.fetch(url("/ultimate"));
    expect(guard.limitOf("default")).toBe(60);

    // A smaller observation is not a current reading; it is a smaller guess.
    await guard.fetch(url("/lite"));
    expect(guard.limitOf("default")).toBe(60);

    // An absent header carries no information and changes nothing.
    await guard.fetch(url("/silent"));
    expect(guard.limitOf("default")).toBe(60);
  });

  test("the search family is 5 per 2 seconds and spends both allowances", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        { path: "/api/v2/deals/search" },
        { path: "/api/v2/itemSearch" },
        ok,
      ]),
    });
    expect(guard.limitOf("search")).toBe(5);

    // Five searches spend the whole search window *and* five default slots.
    await Promise.all(
      Array.from({ length: 5 }, () => guard.fetch(url("/deals/search"))),
    );
    expect(clock.now()).toBe(0);

    // Five more default requests fit; the sixth does not, because the searches
    // already took half the default window.
    await Promise.all(
      Array.from({ length: 6 }, () => guard.fetch(url("/deals"))),
    );
    expect(clock.now()).toBe(2_000);
    expect(guard.dispatches()).toBe(11);
  });

  test("a sixth search waits even though the default window has room", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([{ path: "/api/v2/itemSearch" }]),
    });

    await Promise.all(
      Array.from({ length: 6 }, () => guard.fetch(url("/itemSearch"))),
    );
    expect(clock.now()).toBe(2_000);
  });
});

describe("concurrency", () => {
  test("is fixed at 4, with no way to change it", async () => {
    const clock = new FakeClock();
    let inFlight = 0;
    let peak = 0;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: Transport = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await held;
      inFlight -= 1;
      return new Response("{}", { status: 200 });
    };

    const guard = createGuardedFetch({ clock, transport });
    expect(guard.concurrency).toBe(4);

    const all = Promise.all(
      Array.from({ length: 8 }, () => guard.fetch(url("/deals"))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(4);

    release();
    await all;
    expect(peak).toBe(4);
  });
});

describe("the --max-requests ceiling", () => {
  test("aborts before the ceiling is exceeded, never after", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([ok]),
      maxRequests: 2,
    });

    await guard.fetch(url("/deals"));
    await guard.fetch(url("/deals"));
    const error = await failureOf(guard.fetch(url("/deals")));

    expect(error.code).toBe("request_ceiling");
    expect(error.exit_code).toBe(3);
    expect(error.retry).toBe("never");
    expect(error.details).toMatchObject({ max_requests: 2 });
    // The third request was refused instead of being made, so the counter the
    // trailer reports never exceeds the ceiling.
    expect(guard.dispatches()).toBe(2);
  });

  test("retries spend the headroom, because every attempt is a request", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([
        { path: "/api/v2/deals", status: 500, body: { success: false } },
      ]),
      maxRequests: 3,
    });

    const error = await failureOf(guard.fetch(url("/deals")));

    // Three attempts, all 5xx, and the fourth meets the ceiling before the
    // retry budget of ADR-0011 §8 is spent. The guard is the reported cause.
    expect(error.code).toBe("request_ceiling");
    expect(guard.dispatches()).toBe(3);
  });

  test("the headroom is reserved before dispatch, so concurrent requests cannot overspend it", async () => {
    // Four requests admitted at once against two slots. The reservation is
    // taken synchronously, ahead of the gate's first await, so two of them are
    // refused rather than all four finding the counter still at zero.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: Transport = async () => {
      await held;
      return new Response("{}", { status: 200 });
    };

    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport,
      maxRequests: 2,
    });

    const all = Array.from({ length: 4 }, () =>
      guard.fetch(url("/deals")).then(
        () => "ok" as const,
        (error: unknown) => (error as PdFailure).error.code,
      ),
    );
    release();

    expect(await Promise.all(all)).toEqual([
      "ok",
      "ok",
      "request_ceiling",
      "request_ceiling",
    ]);
    expect(guard.dispatches()).toBe(2);
  });

  test("an absent ceiling is unbounded, which is the default", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([ok]),
    });

    for (let i = 0; i < 20; i += 1) await guard.fetch(url("/deals"));

    expect(guard.dispatches()).toBe(20);
  });
});

describe("a 429 inferred as burst", () => {
  const burst = (reset?: string): Fixture => ({
    path: "/api/v2/deals",
    status: 429,
    headers: {
      "x-ratelimit-remaining": "0",
      ...(reset === undefined ? {} : { "x-ratelimit-reset": reset }),
    },
  });

  test("three strikes end the run as rate_limited, exit 3, in milliseconds", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([burst()]),
    });

    const error = await failureOf(guard.fetch(url("/deals")));

    expect(error.code).toBe("rate_limited");
    expect(error.exit_code).toBe(3);
    expect(error.retry).toBe("after");
    expect(error.retry_after_seconds).toBe(2);
    // Three waits of a flat two seconds — about six real seconds, jumped.
    expect(clock.sleeps.filter((ms) => ms > 0)).toEqual([2_000, 2_000, 2_000]);
    expect(clock.now()).toBe(6_000);
    expect(guard.dispatches()).toBe(4);
  });

  test("each wait is x-ratelimit-reset, clamped to at most 2 seconds", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([burst("1")]),
    });
    await failureOf(guard.fetch(url("/deals")));
    expect(clock.now()).toBe(3_000);

    const clamped = new FakeClock();
    const guardTwo = createGuardedFetch({
      clock: clamped,
      transport: createReplayTransport([burst("900")]),
    });
    await failureOf(guardTwo.fetch(url("/deals")));
    expect(clamped.now()).toBe(6_000);
  });

  test("a strike pauses the whole gate, not just the request that met it", async () => {
    const clock = new FakeClock();
    const dispatchedAt: Record<string, number[]> = { a: [], b: [] };
    let served = 0;
    const transport: Transport = (request) => {
      const key = new URL(request.url).pathname.endsWith("/a") ? "a" : "b";
      dispatchedAt[key]?.push(clock.now());
      served += 1;
      return Promise.resolve(
        key === "a" && served === 1
          ? new Response(null, {
              status: 429,
              headers: { "x-ratelimit-remaining": "0" },
            })
          : new Response("{}", { status: 200 }),
      );
    };

    const guard = createGuardedFetch({ clock, transport });
    const first = guard.fetch(url("/a"));
    // Let the 429 land and the pause take hold before /b is ever queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = guard.fetch(url("/b"));

    await Promise.all([first, second]);
    expect(dispatchedAt.b).toEqual([2_000]);
  });

  test("the burst strikes and the 5xx retries are separate counters", async () => {
    const clock = new FakeClock({ random: () => 1 });
    // One gate, so the two budgets are genuinely sharing a run. The last
    // fixture for a key repeats, so each path answers the same way forever.
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        burst(),
        { path: "/api/v2/persons", status: 503 },
      ]),
    });

    expect((await failureOf(guard.fetch(url("/deals")))).code).toBe(
      "rate_limited",
    );
    expect(guard.dispatches()).toBe(4);

    // Three burst strikes spent nothing from the ten-retry run budget, so this
    // request still gets its full three attempts.
    expect((await failureOf(guard.fetch(url("/persons")))).code).toBe(
      "upstream",
    );
    expect(guard.dispatches()).toBe(8);
  });
});

describe("a 429 that is not inferable as burst", () => {
  test("with x-ratelimit-remaining above zero it is budget_exhausted, never retried", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        {
          path: "/api/v2/deals",
          status: 429,
          headers: { "x-ratelimit-remaining": "17" },
        },
      ]),
    });

    const error = await failureOf(guard.fetch(url("/deals")));
    expect(error.code).toBe("budget_exhausted");
    expect(error.exit_code).toBe(3);
    expect(error.retry).toBe("not_today");
    expect(guard.dispatches()).toBe(1);
    expect(clock.now()).toBe(0);
  });

  test.each([
    ["blank", ""],
    ["whitespace", "   "],
    ["not a number", "unknown"],
    ["fractional", "0.5"],
  ])(
    "a %s x-ratelimit-remaining is no inference at all, so it stops",
    async (_label, value) => {
      const clock = new FakeClock();
      const guard = createGuardedFetch({
        clock,
        transport: createReplayTransport([
          {
            path: "/api/v2/deals",
            status: 429,
            headers: { "x-ratelimit-remaining": value },
          },
        ]),
      });

      // The failure this guards against is specific: a blank header coerces to
      // zero, which reads as a spent burst window and earns the retry loop that
      // blocks the whole company.
      const error = await failureOf(guard.fetch(url("/deals")));
      expect(error.code).toBe("budget_exhausted");
      expect(guard.dispatches()).toBe(1);
      expect(clock.now()).toBe(0);
    },
  );

  test("with the header absent it is budget_exhausted too — in doubt, stop", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        { path: "/api/v2/deals", status: 429 },
      ]),
    });

    const error = await failureOf(guard.fetch(url("/deals")));
    expect(error.code).toBe("budget_exhausted");
    expect(guard.dispatches()).toBe(1);
  });
});

describe("403 is separated by body shape, never by status", () => {
  const cloudflare =
    '<!DOCTYPE html><html><head><title>Access denied</title></head><body>error code: 1015</body></html>';

  test("a Cloudflare HTML body is blocked, and is never retried", async () => {
    const clock = new FakeClock();
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        {
          path: "/api/v2/deals",
          status: 403,
          headers: { "content-type": "text/html" },
          body: cloudflare,
        },
      ]),
    });

    const error = await failureOf(guard.fetch(url("/deals")));
    expect(error.code).toBe("blocked");
    expect(error.exit_code).toBe(3);
    expect(error.retry).toBe("not_today");
    expect(guard.dispatches()).toBe(1);
  });

  test("an HTML body without a content-type is still recognised", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([
        { path: "/api/v2/deals", status: 403, body: cloudflare },
      ]),
    });
    expect((await failureOf(guard.fetch(url("/deals")))).code).toBe("blocked");
  });

  test("an ordinary permission failure is handed back with its body intact", async () => {
    const guard = createGuardedFetch({
      clock: new FakeClock(),
      transport: createReplayTransport([
        {
          path: "/api/v2/deals",
          status: 403,
          body: { success: false, error: "Scope and URL mismatch" },
        },
      ]),
    });

    const response = await guard.fetch(url("/deals"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Scope and URL mismatch",
    });
  });
});

describe("5xx and transport retries", () => {
  test("run at 250 ms / 1 s / 4 s with seeded jitter, then upstream, exit 1", async () => {
    const clock = new FakeClock({ random: () => 1 });
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        { path: "/api/v2/deals", status: 503 },
      ]),
    });

    const error = await failureOf(guard.fetch(url("/deals")));
    expect(error.code).toBe("upstream");
    expect(error.exit_code).toBe(1);
    expect(error.retry).toBe("after");
    expect(clock.sleeps.filter((ms) => ms > 0)).toEqual([250, 1_000, 4_000]);
    expect(guard.dispatches()).toBe(4);
  });

  test("the jitter is full and seeded from the injected clock", async () => {
    const waits = async (seed: number): Promise<number[]> => {
      const clock = new FakeClock({ seed });
      const guard = createGuardedFetch({
        clock,
        transport: createReplayTransport([
          { path: "/api/v2/deals", status: 500 },
        ]),
      });
      await failureOf(guard.fetch(url("/deals")));
      return clock.sleeps.filter((ms) => ms > 0);
    };

    const first = await waits(7);
    expect(await waits(7)).toEqual(first);
    expect(first).not.toEqual(await waits(8));
    // Full jitter: each wait lands somewhere in [0, base].
    expect(first[0]).toBeLessThanOrEqual(250);
    expect(first[1]).toBeLessThanOrEqual(1_000);
    expect(first[2]).toBeLessThanOrEqual(4_000);
  });

  test("a transport failure is retried on the same budget as a 5xx", async () => {
    const clock = new FakeClock({ random: () => 1 });
    let calls = 0;
    const transport: Transport = () => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new Error("ECONNRESET"))
        : Promise.resolve(new Response("{}", { status: 200 }));
    };

    const guard = createGuardedFetch({ clock, transport });
    expect((await guard.fetch(url("/deals"))).status).toBe(200);
    expect(guard.dispatches()).toBe(3);
    expect(clock.sleeps.filter((ms) => ms > 0)).toEqual([250, 1_000]);
  });

  test("the run cap is 10 retries across all requests", async () => {
    const clock = new FakeClock({ random: () => 0 });
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([
        { path: "/api/v2/deals", status: 502 },
      ]),
    });

    // Three requests burn nine of the ten; the fourth gets one retry and stops.
    for (let request = 0; request < 4; request += 1) {
      await failureOf(guard.fetch(url("/deals")));
    }
    expect(guard.dispatches()).toBe(4 + 4 + 4 + 2);
  });
});

describe("the default transport", () => {
  test("throws, so zero Pipedrive requests under bun test is mechanical", async () => {
    const clock = new FakeClock({ random: () => 0 });
    const guard = createGuardedFetch({ clock });
    const error = await failureOf(guard.fetch(url("/deals")));
    // An absent transport is a programmer error, reported as one. It is not
    // retried: burning three of the run's ten retries and calling it `upstream`
    // would disguise the one failure ADR-0019 §3 wants to be unmistakable.
    expect(error.code).toBe("internal");
    expect(error.message).toContain("guardedFetch has no transport");
    expect(guard.dispatches()).toBe(1);
    expect(clock.now()).toBe(0);
  });

  test("names the redacted path and not the query string", async () => {
    const error = await failureOf(
      throwingTransport(new Request(url("/deals?term=secret"))),
    );
    expect(error.message).toContain("GET /api/v2/deals");
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});

describe("fixture replay", () => {
  test("is strict: a request with no fixture is a failure, not a network call", async () => {
    const clock = new FakeClock({ random: () => 0 });
    const guard = createGuardedFetch({
      clock,
      transport: createReplayTransport([ok]),
    });

    const error = await failureOf(guard.fetch(url("/persons")));
    expect(error.code).toBe("internal");
    expect(error.message).toContain("No fixture for GET /api/v2/persons");
    // Not retried, so a miss cannot quietly consume the run's retry budget and
    // corrupt the accounting a surrounding test may be asserting.
    expect(guard.dispatches()).toBe(1);
  });

  test("keys on method, path and the sorted query parameters", async () => {
    const transport = createReplayTransport([
      { path: "/api/v2/deals", query: { limit: 500, cursor: "abc" }, body: { page: 2 } },
    ]);

    const hit = await transport(new Request(url("/deals?cursor=abc&limit=500")));
    expect(await hit.json()).toEqual({ page: 2 });

    const miss = await transport(new Request(url("/deals?cursor=xyz&limit=500"))).then(
      () => "served",
      () => "refused",
    );
    expect(miss).toBe("refused");
  });

  test("serves a sequence in order and repeats the last entry", async () => {
    const transport = createReplayTransport([
      { path: "/api/v2/deals", status: 500 },
      { path: "/api/v2/deals", status: 200, body: { data: [] } },
    ]);
    expect((await transport(new Request(url("/deals")))).status).toBe(500);
    expect((await transport(new Request(url("/deals")))).status).toBe(200);
    expect((await transport(new Request(url("/deals")))).status).toBe(200);
  });
});

describe("the injected clock", () => {
  test("covers now() and sleep(), and sleep advances now", async () => {
    const clock = new FakeClock({ start: 1_000 });
    expect(clock.now()).toBe(1_000);
    await clock.sleep(250);
    expect(clock.now()).toBe(1_250);
    expect(clock.sleeps).toEqual([250]);
  });

  test("random() is deterministic for a seed", () => {
    const draw = (seed: number): number[] =>
      Array.from({ length: 4 }, () => new FakeClock({ seed }).random());
    expect(draw(3)).toEqual(draw(3));
    expect(new FakeClock({ seed: 3 }).random()).not.toBe(
      new FakeClock({ seed: 4 }).random(),
    );
  });
});
