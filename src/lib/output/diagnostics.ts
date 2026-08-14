/** Human-only run diagnostics. stderr is prose and never a machine contract. */

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
	cacheHit: boolean;
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
	readonly #enabled: boolean;
	readonly #startedAt: number;
	readonly #timer: ReturnType<typeof setInterval> | undefined;
	#records = 0;
	#lastStatusWidth = 0;
	#finished = false;

	constructor({
		sink = defaultSink,
		isTty = stderrIsTty,
		verbose = false,
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
		this.#enabled = verbose || isTty();
		this.#startedAt = startedAt ?? clock.now();
		if (this.#enabled) {
			this.#timer = setInterval(() => this.refresh(), 1_000);
			this.#timer.unref?.();
		}
	}

	record(count = 1): void {
		this.#records += count;
	}

	refresh(): void {
		if (!this.#enabled || this.#finished) return;
		const pacing = this.#pacing();
		const pacingText =
			pacing === undefined
				? ""
				: `, gate ${pacing.defaultLimit}/${pacing.searchLimit} per 2s, concurrency ${pacing.concurrency}`;
		const status = `pd: ${this.#records} records, ${this.#requests()} requests, ${this.#elapsed()}${pacingText}`;
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

	request({
		request,
		response,
		durationMs,
		attempt,
		cacheHit,
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
				`cache_hit=${cacheHit ? "yes" : "no"}${headers === "" ? "" : ` headers=${headers}`}`,
		);
	}

	sizeWarning(message: string): void {
		if (this.#enabled) this.anomaly(message);
		else this.#sink(`pd: ${message}\n`);
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
		this.#clearStatus();
		const ceiling =
			this.#maxRequests === undefined ? "" : `, ceiling ${this.#maxRequests}`;
		this.#sink(
			`pd: finished: ${this.#records} records, ${this.#requests()} requests, ${this.#elapsed()}${ceiling}\n`,
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
