/**
 * Strict fixture replay — ADR-0019 §2, §3.
 *
 * Installed as the `transport` of `guardedFetch`, which is where the v1 and v2
 * traffic converges, and which sits **below** the non-GET refusal: a test cannot
 * test its way past the read-only property, and every replay test is silently
 * another execution of ADR-0013's refusal path.
 *
 * There is **no passthrough**. A request with no matching fixture is a test
 * failure, never a network call.
 *
 * Fixtures are keyed by method, path and the sorted query parameters `pd`
 * actually varies (ADR-0019 §3). Two requests differing only in a parameter `pd`
 * never sends collapse to one fixture; two differing in `cursor` or `ids` do
 * not.
 *
 * This store is **not** the ADR-0005 cache, and ADR-0019 §6 explains why sharing
 * them would be a false economy: fixtures never expire, are not keyed by
 * credential, and are committed.
 */

import { pdError } from "../../src/lib/errors.ts";
import { PdFailure } from "../../src/lib/pipedrive/failure.ts";
import type { Transport } from "../../src/lib/pipedrive/guarded-fetch.ts";

export type Fixture = {
  /** GET unless a test is deliberately recording something else. */
  method?: string;
  path: string;
  query?: Record<string, string | number>;
  status?: number;
  headers?: Record<string, string>;
  /** A string is served verbatim; anything else is JSON-encoded. */
  body?: unknown;
};

export const fixtureKey = (
  method: string,
  path: string,
  query: Iterable<[string, string]>,
): string => {
  const sorted = [...query]
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join("&");
  return `${method.toUpperCase()} ${path}${sorted === "" ? "" : `?${sorted}`}`;
};

const keyOfFixture = (fixture: Fixture): string =>
  fixtureKey(
    fixture.method ?? "GET",
    fixture.path,
    Object.entries(fixture.query ?? {}).map(([name, value]) => [
      name,
      String(value),
    ]),
  );

const keyOfRequest = (request: Request): string => {
  const url = new URL(request.url);
  return fixtureKey(request.method, url.pathname, url.searchParams);
};

const toResponse = (fixture: Fixture): Response => {
  const isText = typeof fixture.body === "string";
  const body =
    fixture.body === undefined
      ? null
      : isText
        ? (fixture.body as string)
        : JSON.stringify(fixture.body);
  return new Response(body, {
    status: fixture.status ?? 200,
    headers: {
      ...(body === null || isText
        ? {}
        : { "content-type": "application/json" }),
      ...fixture.headers,
    },
  });
};

/**
 * Several fixtures may share a key: they are served in order, and the last one
 * repeats once the sequence is spent. That is what a retry test needs — a 500
 * followed by a 200 — without inventing a second keying dimension for it.
 */
export const createReplayTransport = (fixtures: readonly Fixture[]): Transport => {
  const byKey = new Map<string, Fixture[]>();
  for (const fixture of fixtures) {
    const key = keyOfFixture(fixture);
    byKey.set(key, [...(byKey.get(key) ?? []), fixture]);
  }
  const served = new Map<string, number>();

  return (request) => {
    const key = keyOfRequest(request);
    const sequence = byKey.get(key) ?? [];
    const index = Math.min(served.get(key) ?? 0, sequence.length - 1);
    const fixture = sequence[index];
    if (fixture === undefined) {
      // A `PdFailure` rather than an `Error`, so `guardedFetch` reports the miss
      // instead of retrying it three times and calling it `upstream`. A missing
      // fixture is a programmer error, which is what `internal` means.
      return Promise.reject(
        new PdFailure(
          pdError({
            code: "internal",
            message:
              `No fixture for ${key}. Known keys: ${[...byKey.keys()].join(", ") || "(none)"}`,
          }),
        ),
      );
    }
    served.set(key, index + 1);
    return Promise.resolve(toResponse(fixture));
  };
};
