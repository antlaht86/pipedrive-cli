/**
 * `guardedFetch` — the single HTTP seam. Locked point 7, ADR-0011, ADR-0013 §1
 * layer (b), ADR-0019 §2.
 *
 * Every HTTP request `pd` will ever make passes through this module. It owns
 * **all** of the following, and no other module may own any of them:
 *
 * - the non-GET refusal (ADR-0013 §1 layer b, §4, §5);
 * - the rolling 2-second burst gate and its upward-only adaptation (ADR-0011 §1, §2, §5);
 * - the fixed concurrency of 4 (ADR-0011 §3, §4);
 * - the whole-gate 429 pause and the three-strike burst budget (ADR-0011 §6, §7);
 * - the 5xx and transport retry budget (ADR-0011 §8);
 * - request accounting (ADR-0011 §9);
 * - the `--max-requests` ceiling and its headroom (ADR-0010 §3, ADR-0026 §3);
 * - URL redaction before anything reaches `details` (ADR-0001 §"The error object").
 *
 * If any of these ever appears in a page loop, in a resolver, or in a command,
 * this decision has been violated. Both generated clients share one instance of
 * this module; they differ only in `baseUrl`.
 *
 * ## Two injected dependencies, and nothing more
 *
 * A `transport` (ADR-0019 §2 — fixture replay installs here) and a `Clock`
 * (ADR-0019 §4). The transport defaults to one that **throws**, so "zero
 * Pipedrive requests under `bun test`" is mechanical rather than disciplinary:
 * a test that forgets a fixture fails in the same run, on the developer's own
 * machine. Production wiring passes `globalThis.fetch` explicitly.
 *
 * The refusal sits **above** the transport, so replay cannot test its way past
 * the read-only property and every replay test is another execution of the
 * refusal path (ADR-0019 §2).
 *
 * There is no test-only flag and no test-only environment variable (ADR-0019 §5),
 * and no flag, environment variable or manifest entry for the gate or the
 * concurrency (ADR-0011 §4).
 */

import pLimit from "p-limit";
import { Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import { pdError } from "../errors.ts";
import type { PdErrorInput } from "../errors.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { PdFailure, isPdFailure } from "./failure.ts";

/** Every refusal out of this module has the same shape; ADR-0023 §1 explains the throw. */
const fail = (input: PdErrorInput): PdFailure => new PdFailure(pdError(input));

/**
 * The per-company form (`https://<company>.pipedrive.com`) is not used: learning
 * the company domain requires an operation `pd` does not have.
 */
export const PIPEDRIVE_BASE_URL = "https://api.pipedrive.com";
export const PIPEDRIVE_V1_BASE_URL = `${PIPEDRIVE_BASE_URL}/v1`;
export const PIPEDRIVE_V2_BASE_URL = `${PIPEDRIVE_BASE_URL}/api/v2`;

export type Transport = (request: Request) => Promise<Response>;

/** ADR-0011 §10: keyed families, so ticket 14 adds a key rather than a module. */
export type GateFamily = "default" | "search";

const WINDOW_MS = 2_000;

/**
 * ADR-0011 §2. The assumed ceiling is the smallest documented plan — Lite, 20
 * requests per 2 seconds — because the plan tier is unreadable and guessing high
 * is the guess that escalates. `pd` takes half of it, since the token may be
 * driving other scripts that cannot see `pd` as the cause of their 429s.
 */
const ASSUMED_PLAN_WINDOW = 20;
const DEFAULT_FAMILY_LIMIT = ASSUMED_PLAN_WINDOW / 2;

/**
 * ADR-0011 §10. The Search API ceiling is 10 per 2 seconds, uniform across all
 * plans and auth types, halved by §2 like every other allowance. It is not
 * raised by `x-ratelimit-limit`: that header reports the plan's general window,
 * and the search ceiling does not move with the plan.
 */
const SEARCH_FAMILY_LIMIT = 5;

/** ADR-0011 §3: derived, not chosen. No flag, no environment variable. */
const CONCURRENCY = 4;

/** ADR-0011 §7: three strikes per **run**, because a 429 is a gate-wide event. */
const MAX_BURST_STRIKES = 3;
const MAX_BURST_WAIT_MS = 2_000;

/**
 * ADR-0011 §8, as fixed by ADR-0023 §2: "3 attempts per request" is the first
 * dispatch plus these three waits, so a request that keeps meeting a 5xx is
 * dispatched at most four times. `retriesUsed` is a **separate** counter from
 * the burst strikes: a 5xx is Pipedrive failing, not `pd` being too fast, and
 * the two must not exhaust each other.
 */
const BACKOFF_MS = [250, 1_000, 4_000] as const;
const MAX_RETRIES_PER_RUN = 10;

/**
 * ADR-0001: a request URL carries user-supplied search terms and filter values.
 * That is company data and it has no business on an agent's stdout, so the query
 * string never enters `details`. Enforced here rather than left to whoever
 * writes the field.
 */
const parseUrl = Result.fromThrowable((url: string) => new URL(url));

export const redactUrl = (url: string): string =>
  parseUrl(url).match(
    (parsed) => parsed.pathname,
    () => "<unparseable url>",
  );

/**
 * ADR-0011 §10 records that the membership of "the Search API" is inference from
 * path names rather than a documented list. These are the paths the generated v2
 * surface actually exposes: `/deals/search`, `/persons/search`, …, plus
 * `/itemSearch` and `/itemSearch/field`.
 */
const isSearchPath = (path: string): boolean =>
  /\/search(\/|$)/i.test(path) || /\/itemsearch(\/|$)/i.test(path);

const familyOf = (path: string): GateFamily =>
  isSearchPath(path) ? "search" : "default";

/**
 * The three burst headers, parsed at the boundary rather than read. `undefined`
 * means *the header said nothing usable*, and the callers below are built on
 * that meaning: ADR-0001 turns an unavailable inference into `budget_exhausted`
 * and a stop, so a header that coerces to a number it does not contain is a
 * safety bug, not a rounding error.
 *
 * `z.coerce.number()` maps a blank string to `0` — which is exactly the value
 * that would make an unattributable 429 look like a spent burst window and earn
 * the retry loop that blocks the whole company. The blank is rejected before the
 * coercion for that reason and no other.
 */
const RateLimitHeader = z.coerce.number().int().nonnegative();

const rateLimitHeader = (
  response: Response,
  name: string,
): number | undefined => {
  const raw = response.headers.get(name)?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = RateLimitHeader.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

/**
 * ADR-0001 and ADR-0010 §6: the Cloudflare block body is an HTML error page, and
 * 403 is overloaded between that block and an ordinary permission failure. They
 * are separated by **body shape**, never by status, and a response is never
 * assumed to be JSON.
 */
const looksLikeHtml = (body: string, contentType: string | null): boolean =>
  /^\s*(<!doctype\s+html|<html)/i.test(body) ||
  (contentType?.toLowerCase().includes("text/html") ?? false);

/** A rolling-window admission counter. ADR-0011 §1: this is not `p-limit`. */
class RollingWindow {
  #admissions: number[] = [];
  #limit: number;

  constructor(
    limit: number,
    private readonly clock: Clock,
  ) {
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  /** ADR-0011 §5: upward only. An absent header carries no information. */
  raiseTo(limit: number): void {
    if (limit > this.#limit) this.#limit = limit;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.#admissions = this.#admissions.filter((at) => at > now - WINDOW_MS);
      if (this.#admissions.length < this.#limit) {
        this.#admissions.push(now);
        return;
      }
      const oldest = this.#admissions[0] ?? now;
      await this.clock.sleep(oldest + WINDOW_MS - now);
    }
  }
}

/**
 * ADR-0011 §6: a 429 stops the gate admitting **every** request, in flight and
 * queued. Retrying only the failed request while its siblings continue is how a
 * stream of 429s — and then a Cloudflare 403 on the whole company's traffic — is
 * earned.
 */
class BurstGate {
  readonly #families: Record<GateFamily, RollingWindow>;
  #pausedUntil = 0;

  constructor(private readonly clock: Clock) {
    this.#families = {
      default: new RollingWindow(DEFAULT_FAMILY_LIMIT, clock),
      search: new RollingWindow(SEARCH_FAMILY_LIMIT, clock),
    };
  }

  limitOf(family: GateFamily): number {
    return this.#families[family].limit;
  }

  raiseDefaultTo(limit: number): void {
    this.#families.default.raiseTo(limit);
  }

  pauseFor(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.clock.now() + ms);
  }

  async admit(family: GateFamily): Promise<void> {
    await this.#awaitResume();
    // ADR-0011 §10, gap 11: the conservative reading is that a search request
    // spends **both** allowances, and that is the one to assume until observed.
    if (family === "search") await this.#families.search.acquire();
    await this.#families.default.acquire();
    // A pause may have begun while this request queued for a slot.
    await this.#awaitResume();
  }

  async #awaitResume(): Promise<void> {
    for (;;) {
      const remaining = this.#pausedUntil - this.clock.now();
      if (remaining <= 0) return;
      await this.clock.sleep(remaining);
    }
  }
}

/**
 * ADR-0019 §3: the network path is not merely unused under `bun test`, it is
 * unreachable. Only the live suite of ADR-0019 §9 constructs a real transport.
 */
export const throwingTransport: Transport = (request) => {
  const method = request.method.toUpperCase();
  return Promise.reject(
    // A `PdFailure` rather than an `Error` so the retry loop lets it through
    // untouched: an absent transport is a programmer error, and burning three
    // retries and reporting it as `upstream` would disguise the one failure
    // ADR-0019 §3 wants to be unmistakable.
    fail({
      code: "internal",
      message:
        `guardedFetch has no transport: ${method} ${redactUrl(request.url)} was not served by a fixture. ` +
        "Record one, or construct the gate with an explicit transport.",
      details: { method, path: redactUrl(request.url) },
    }),
  );
};

export type GuardedFetchOptions = {
  transport?: Transport;
  clock?: Clock;
  /**
   * ADR-0010 §3's `--max-requests`, the only quantitative guard `pd` offers.
   * `undefined` is the default: absent the flag, a run is unbounded in requests.
   */
  maxRequests?: number;
  /**
   * Called once, at the instant a Cloudflare block is recognised — ADR-0010 §6.
   * The prologue hangs the sentinel write on it.
   *
   * It is a callback rather than a store because this module must not learn what
   * a credential is: the sentinel is keyed by the token's fingerprint and the
   * gate is built before any token is resolved. It fires *here* rather than
   * wherever the error surfaces so that a run refused **from** the sentinel can
   * never reach it — that path makes no request, so it never enters this module,
   * and the fifteen minutes therefore cannot be pushed forward by a looping
   * agent (ADR-0010 §7).
   */
  onBlocked?: () => void;
};

export type GuardedFetch = {
  /**
   * `typeof fetch` exactly, which is the type both generated clients accept for
   * their per-call and per-client `fetch` override.
   */
  fetch: typeof fetch;
  /**
   * ADR-0011 §9: every attempt is a network request and is counted as one.
   * ADR-0019 §2: every *"and no request was made"* assertion in the map is this
   * one question put to this one object.
   */
  dispatches: () => number;
  /** ADR-0010 §4: enrichment may dispatch only while one request remains afterward. */
  canDispatchEnrichment: () => boolean;
  /** For ADR-0015's stderr diagnostics, which report what paced a slow run. */
  limitOf: (family: GateFamily) => number;
  concurrency: number;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const toRequest = (input: FetchInput, init?: FetchInit): Request => {
  if (input instanceof Request) {
    return init === undefined ? input : new Request(input, init);
  }
  return new Request(typeof input === "string" ? input : input.href, init);
};

export const createGuardedFetch = ({
  transport = throwingTransport,
  clock = systemClock,
  maxRequests,
  onBlocked,
}: GuardedFetchOptions = {}): GuardedFetch => {
  const gate = new BurstGate(clock);
  const limiter = pLimit(CONCURRENCY);

  let dispatches = 0;
  let burstStrikes = 0;
  let retriesUsed = 0;

  /** ADR-0011 §5: half of an observed ceiling, for the rest of the process. */
  const observeCeiling = (response: Response): void => {
    const observed = rateLimitHeader(response, "x-ratelimit-limit");
    if (observed !== undefined && observed > 0) {
      gate.raiseDefaultTo(Math.floor(observed / 2));
    }
  };

  /**
   * ADR-0011 §7. Research gap 3 records that the unit of `x-ratelimit-reset` is
   * undocumented — seconds, milliseconds or a timestamp. It is read as seconds,
   * and the 2-second clamp makes the assumption harmless in every direction,
   * because the window it describes is only 2 seconds wide.
   */
  const burstWaitMs = (response: Response): number => {
    const reset = rateLimitHeader(response, "x-ratelimit-reset");
    if (reset === undefined || reset <= 0) return MAX_BURST_WAIT_MS;
    return Math.min(reset * 1_000, MAX_BURST_WAIT_MS);
  };

  /**
   * ADR-0010 §3: the guard aborts **before** the ceiling is exceeded, so the
   * headroom is taken here — synchronously, at the top of the retry loop and
   * ahead of `gate.admit`'s first `await`.
   *
   * Two properties come out of that placement and neither is incidental. The
   * reservation and its test cannot be split by another request's turn, so four
   * concurrent walkers cannot each read the same last slot. And a retry passes
   * through this point again, which is what makes a retried 5xx spend headroom
   * — ADR-0011 §9 counts every attempt as a request, and a guard that a retry
   * storm could walk past would not be a ceiling.
   *
   * `dispatches` is the reservation counter as well as the trailer's `requests`,
   * because a reservation is always followed by a dispatch: nothing between here
   * and `transport` can decline. One counter cannot disagree with itself.
   */
  const reserve = (path: string): void => {
    if (maxRequests !== undefined && dispatches >= maxRequests) {
      throw fail({
        code: "request_ceiling",
        message: `Stopped after ${maxRequests} requests; raise --max-requests and run again.`,
        details: { max_requests: maxRequests, path },
      });
    }
    dispatches += 1;
  };

  const dispatch = async (request: Request, path: string): Promise<Response> => {
    const family = familyOf(path);
    let retriesForThisRequest = 0;

    for (;;) {
      reserve(path);
      await gate.admit(family);

      const attempt = await ResultAsync.fromPromise(
        transport(request),
        (cause) => cause,
      );

      // A transport that refuses with a `PdFailure` has already said what went
      // wrong and that waiting cannot fix it — a missing fixture, an absent
      // transport. Retrying it would burn three of the run's ten retries and
      // report `upstream`, which disguises the very failure ADR-0019 §3 wants
      // to be unmistakable.
      if (attempt.isErr() && isPdFailure(attempt.error)) throw attempt.error;

      // Anything else the transport threw, and every 5xx, share one budget:
      // both are "Pipedrive or the network failed", and neither escalates to
      // Cloudflare.
      if (attempt.isErr() || attempt.value.status >= 500) {
        if (
          retriesForThisRequest >= BACKOFF_MS.length ||
          retriesUsed >= MAX_RETRIES_PER_RUN
        ) {
          throw fail({
            code: "upstream",
            message: "Pipedrive failed to answer and the retry budget is spent.",
            retryAfterSeconds: Math.ceil(
              (BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0) / 1_000,
            ),
            details: {
              path,
              ...(attempt.isErr()
                ? { transport_error: String(attempt.error) }
                : { status: attempt.value.status }),
              retries_used: retriesUsed,
            },
          });
        }
        const base = BACKOFF_MS[retriesForThisRequest] ?? 0;
        // Full jitter, seeded from the injected clock (ADR-0019 §4).
        const wait = Math.round(base * clock.random());
        retriesForThisRequest += 1;
        retriesUsed += 1;
        await clock.sleep(wait);
        continue;
      }

      const response = attempt.value;
      observeCeiling(response);

      if (response.status === 429) {
        // ADR-0001: `x-ratelimit-remaining` above zero implies the daily pool
        // rather than the spent burst window. When the inference is unavailable
        // `pd` chooses `budget_exhausted` and stops, because the opposite
        // mistake is the retry loop that blocks the whole company.
        const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
        if (remaining !== 0) {
          throw fail({
            code: "budget_exhausted",
            message:
              "Pipedrive refused the request and it cannot be attributed to the 2-second burst window. " +
              "The shared daily token budget is the likely cause; pd stops rather than risk a company-wide block.",
            details: { path, status: 429, rate_limit_remaining: remaining ?? null },
          });
        }

        const wait = burstWaitMs(response);
        if (burstStrikes >= MAX_BURST_STRIKES) {
          throw fail({
            code: "rate_limited",
            message:
              "The 2-second burst window was exhausted three times and the retries are spent.",
            retryAfterSeconds: Math.ceil(wait / 1_000),
            details: { path, status: 429, burst_strikes: burstStrikes },
          });
        }
        burstStrikes += 1;
        gate.pauseFor(wait);
        continue;
      }

      if (response.status === 403) {
        // The body is read, never parsed. A JSON 403 is handed back untouched
        // for the caller to map to `forbidden`; only the HTML block is ours.
        const body = await ResultAsync.fromPromise(
          response.clone().text(),
          () => undefined,
        ).unwrapOr("");
        if (looksLikeHtml(body, response.headers.get("content-type"))) {
          // ADR-0010 §6, before the throw: the next invocation on this
          // credential must refuse without asking Pipedrive again.
          onBlocked?.();
          throw fail({
            code: "blocked",
            message:
              "Pipedrive's edge is blocking this company's API traffic. Stop using pd and tell a human.",
            details: { path, status: 403 },
          });
        }
      }

      return response;
    }
  };

  const guarded = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const request = toRequest(input, init);
    const method = request.method.toUpperCase();
    const path = redactUrl(request.url);

    // Read-only layer (b), ADR-0013 §1. This inspects the request the runtime is
    // about to issue, not the argument it was handed, because the point of the
    // layer is to catch a caller that lied. It fires **before** the gate, so no
    // dispatch is counted and — ADR-0013 §5 — no write reached Pipedrive.
    if (method !== "GET") {
      return Promise.reject(
        fail({
          code: "write_blocked",
          message:
            "pd attempted a non-GET request. This is a bug in pd, not a usage error.",
          details: { method, path },
        }),
      );
    }

    return limiter(() => dispatch(request, path));
  };

  return {
    // `preconnect` is part of the runtime's `fetch` shape, so the guarded
    // function has to carry it to be assignable. It is a no-op on purpose: it
    // is a performance hint with no response and no accounting, and opening a
    // socket outside the gate is exactly what this module exists to prevent.
    fetch: Object.assign(guarded, { preconnect: (): void => {} }),
    dispatches: () => dispatches,
    canDispatchEnrichment: () =>
      maxRequests === undefined || dispatches + 1 < maxRequests,
    limitOf: (family) => gate.limitOf(family),
    concurrency: CONCURRENCY,
  };
};
