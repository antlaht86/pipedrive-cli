/** Human-only run diagnostics. stderr is prose and never a machine contract. */

import type { CacheEntryName } from "../cache/entries.ts";
import type { Clock } from "../pipedrive/clock.ts";
import { systemClock } from "../pipedrive/clock.ts";
import type { Sink } from "./ndjson-writer.ts";

const QUERY_VALUE_ALLOWLIST = new Set([
	"limit",
	"cursor",
	"sort_by",
	"sort_direction",
	"include_option_labels",
	"ids",
	"custom_fields",
	"exact_match",
	"item_types",
	"fields",
	"status",
	"person_id",
	"organization_id",
	"owner_id",
	"org_id",
	"deal_id",
	"pipeline_id",
	"stage_id",
	"done",
	"filter_id",
	"updated_since",
	"updated_until",
]);

const HEADER_ALLOWLIST = new Set([
	"x-ratelimit-limit",
	"x-ratelimit-remaining",
	"x-ratelimit-reset",
	"retry-after",
	"content-type",
]);

const safeUrl = (url: string): { path: string; query: string } => {
	const parsed = URL.parse(url);
	if (parsed === null) return { path: "<unparseable url>", query: "" };
	const query = [...parsed.searchParams].map(
		([name, value]) =>
			`${name}=${QUERY_VALUE_ALLOWLIST.has(name) && name !== "term" ? value : "[redacted]"}`,
	);
	return { path: parsed.pathname, query: query.join("&") };
};

const safeHeaders = (...sources: readonly Headers[]): string => {
	const shown = new Map<string, string>();
	for (const headers of sources) {
		headers.forEach((value, rawName) => {
			const name = rawName.toLowerCase();
			// Kept as a second, explicit guard: the credential header remains refused
			// even if somebody accidentally edits the allowlist above.
			if (name === "x-api-token" || !HEADER_ALLOWLIST.has(name)) return;
			shown.set(name, value);
		});
	}
	return [...shown].map(([name, value]) => `${name}=${value}`).join(",");
};

export type RequestDiagnostic = {
	request: Request;
	response?: Response;
	durationMs: number;
	attempt: number;
	/** Pipedrive's or Cloudflare's, from `age` / `x-cache` / `cf-cache-status`. */
	upstreamCacheHit: boolean;
	transportError?: boolean;
};

export type PacingDiagnostic = {
	defaultLimit: number;
	searchLimit: number;
	concurrency: number;
};

export type RunDiagnosticsOptions = {
	sink?: Sink;
	/** The sole TTY seam. Production checks stderr's descriptor, not stdout's. */
	isTty?: () => boolean;
	verbose?: boolean;
	/** ADR-0015: names the otherwise-silent buffering phase. */
	pretty?: boolean;
	clock?: Clock;
	startedAt?: number;
	requests: () => number;
	pacing?: () => PacingDiagnostic | undefined;
	maxRequests?: number;
};

const defaultSink: Sink = (text) => process.stderr.write(text);
const stderrIsTty = (): boolean => process.stderr.isTTY === true;

export class RunDiagnostics {
	readonly #sink: Sink;
	readonly #clock: Clock;
	readonly #requests: () => number;
	readonly #pacing: () => PacingDiagnostic | undefined;
	readonly #maxRequests: number | undefined;
	readonly #verbose: boolean;
	readonly #pretty: boolean;
	readonly #enabled: boolean;
	readonly #startedAt: number;
	readonly #timer: ReturnType<typeof setInterval> | undefined;
	#records = 0;
	#lastStatusWidth = 0;
	#finished = false;
	#redrawPending = false;

	constructor({
		sink = defaultSink,
		isTty = stderrIsTty,
		verbose = false,
		pretty = false,
		clock = systemClock,
		startedAt,
		requests,
		pacing = () => undefined,
		maxRequests,
	}: RunDiagnosticsOptions) {
		this.#sink = sink;
		this.#clock = clock;
		this.#requests = requests;
		this.#pacing = pacing;
		this.#maxRequests = maxRequests;
		this.#verbose = verbose;
		this.#pretty = pretty;
		this.#enabled = verbose || isTty();
		this.#startedAt = startedAt ?? clock.now();
		if (this.#enabled) {
			this.#timer = setInterval(() => this.refresh(), 1_000);
			this.#timer.unref?.();
		}
	}

	record(count = 1): void {
		this.#records += count;
		this.#scheduleRedraw();
	}

	/**
	 * The counter climbs while a page is emitted, but the last thing to have
	 * drawn the status line may be an anomaly raised before that page arrived —
	 * `rate-limit gate raised…` fires on the response headers, so its redraw
	 * shows `0 records` next to a completed request. A page therefore redraws
	 * once itself, coalesced into a microtask so ADR-0015's "on a timer, not per
	 * record" cost holds: a whole page of records costs one write, not one each.
	 */
	#scheduleRedraw(): void {
		if (!this.#enabled || this.#finished || this.#redrawPending) return;
		this.#redrawPending = true;
		queueMicrotask(() => {
			if (this.#redrawPending) this.refresh();
		});
	}

	/**
	 * Ticket 24. The status line carries no newline — that is what makes it
	 * rewritable — so the cursor stays parked on it. stdout owns the same
	 * terminal on a bare `pd deals list`, which satisfies §2's TTY gate exactly,
	 * and a `record` line written there would land on the status text and scroll
	 * it into scrollback, where no later `\r` can reach it. The status line
	 * therefore gives the line back before stdout uses it, and is redrawn below
	 * whatever stdout wrote.
	 *
	 * `#clearStatus` zeroes the width, so the second and every later record of a
	 * page returns at the guard: the clear costs one write per page, the same
	 * cadence as the redraw ticket 23 pairs it with. It is unconditional rather
	 * than gated on stdout being a TTY — §2 puts the detection on stderr's own
	 * descriptor and nowhere else, and the wasted clear on a redirected stdout is
	 * one stderr write per page.
	 *
	 * It asks for **no** redraw of its own. A page's records have already
	 * scheduled one before the first of them reaches stdout, and the writes that
	 * have not — a `warning` line, the trailer — are answered by §4's 1 Hz timer
	 * or by nothing at all, because the run has ended. Scheduling here instead
	 * would leave a redraw owing at the trailer and cost a draw the next
	 * statement erases.
	 */
	yieldLine(): void {
		if (!this.#enabled || this.#finished || this.#lastStatusWidth === 0) return;
		this.#clearStatus();
	}

	refresh(): void {
		if (!this.#enabled || this.#finished) return;
		// Every draw settles the debt, whoever asked for it: a timer tick landing
		// between the records and the microtask leaves that microtask nothing to do.
		this.#redrawPending = false;
		const pacing = this.#pacing();
		const pacingText =
			pacing === undefined
				? ""
				: `, gate ${pacing.defaultLimit}/${pacing.searchLimit} per 2s, concurrency ${pacing.concurrency}`;
		const phase = this.#pretty ? "records collected (buffering)" : "records";
		const status = `pd: ${this.#records} ${phase}, ${this.#requests()} requests, ${this.#elapsed()}${pacingText}`;
		const padding = " ".repeat(
			Math.max(0, this.#lastStatusWidth - status.length),
		);
		this.#sink(`\r${status}${padding}`);
		this.#lastStatusWidth = status.length;
	}

	anomaly(message: string): void {
		if (!this.#enabled || this.#finished) return;
		this.#clearStatus();
		this.#sink(`pd: ${message}\n`);
		this.refresh();
	}

	/**
	 * Ticket 25. `pd`'s own cache short-circuits before a request is formed, so a
	 * hit on one of ADR-0005's entries can never appear on the per-request line
	 * below — it would have to be a line about a request that was not made. It
	 * gets its own line instead, and the pair is what makes a cold run and a warm
	 * run of the same command tell themselves apart on stderr alone.
	 *
	 * Gated on `--verbose` rather than on `#enabled`, exactly as the per-request
	 * line is: §5 puts the request log behind the flag, and this is its
	 * counterpart. A bare TTY run keeps its status line and its anomalies and
	 * gains nothing here.
	 */
	cacheServed(entry: CacheEntryName): void {
		if (!this.#verbose || this.#finished) return;
		this.anomaly(`${entry} served from cache, no request`);
	}

	request({
		request,
		response,
		durationMs,
		attempt,
		upstreamCacheHit,
		transportError = false,
	}: RequestDiagnostic): void {
		if (!this.#verbose || this.#finished) return;
		const { path, query } = safeUrl(request.url);
		const headers = safeHeaders(
			request.headers,
			response?.headers ?? new Headers(),
		);
		const status = transportError
			? "transport-error"
			: (response?.status ?? "unknown");
		this.anomaly(
			`${request.method.toUpperCase()} ${path}${query === "" ? "" : `?${query}`} ` +
				`status=${status} duration=${durationMs}ms attempt=${attempt} ` +
				`upstream_cache_hit=${upstreamCacheHit ? "yes" : "no"}${headers === "" ? "" : ` headers=${headers}`}`,
		);
	}

	warning(message: string): void {
		if (this.#enabled) this.anomaly(message);
		else this.#sink(`pd: ${message}\n`);
	}

	sizeWarning(message: string): void {
		this.warning(message);
	}

	error(message: string): void {
		if (!this.#finished && this.#enabled) this.#finishLine();
		this.#sink(`pd: ${message}\n`);
		this.#stop();
	}

	finish(): void {
		if (this.#finished) return;
		if (this.#enabled) this.#finishLine();
		this.#stop();
	}

	#finishLine(): void {
		// A bounded single-page run reaches the trailer in the same tick as its
		// records, so the coalesced redraw has not run yet. Draw it here, before
		// the clear, so the last status line ever written agrees with the count on
		// the `finished:` line below it and on the trailer.
		if (this.#redrawPending) this.refresh();
		this.#clearStatus();
		const ceiling =
			this.#maxRequests === undefined ? "" : `, ceiling ${this.#maxRequests}`;
		const noun = this.#pretty ? "records collected" : "records";
		this.#sink(
			`pd: finished: ${this.#records} ${noun}, ${this.#requests()} requests, ${this.#elapsed()}${ceiling}\n`,
		);
	}

	#clearStatus(): void {
		if (this.#lastStatusWidth === 0) return;
		this.#sink(`\r${" ".repeat(this.#lastStatusWidth)}\r`);
		this.#lastStatusWidth = 0;
	}

	#elapsed(): string {
		return `${((this.#clock.now() - this.#startedAt) / 1_000).toFixed(1)}s`;
	}

	#stop(): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
	}
}
