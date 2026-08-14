/**
 * The wrapper seam — the only place a generated SDK function is called, and the
 * place a `Response` becomes a `Result<unknown, PdError>`.
 *
 * `guardedFetch` (ADR-0023 §1) hands back **every** status it does not itself
 * own, as a `Response`, untouched: 401, a JSON 403, 404 and any other 4xx. The
 * refusals and the spent budgets travel as a thrown `PdFailure`. Ticket 04
 * recorded that mapping the first group to `auth` / `forbidden` / `not_found` is
 * this module's job, with `fromPromise` unwrapping the carrier. That is exactly
 * what `readBody` below does, and it is the whole of this module's authority:
 * no retry, no gate, no accounting, no cursor knowledge.
 *
 * ## Why `parseAs: "text"`
 *
 * ADR-0006 §2's first structural row is *body is not JSON*. The generated client
 * would parse the body itself and fold a `SyntaxError` into the same untyped
 * `error` field as a transport failure — which is the merge ADR-0006 §1 turned
 * `sdk.validator` off to avoid, arriving one layer lower. Reading the body as
 * text and owning the `JSON.parse` keeps the classification here, where the
 * error union is.
 *
 * ADR-0001 also requires that a response is never *assumed* to be JSON. The
 * Cloudflare HTML block is already caught below `guardedFetch`, so an HTML body
 * reaching this module is an ordinary surprise rather than a company-wide
 * incident — and it becomes `invalid_response`, which is what it is.
 *
 * ## Why not the generated `client` singleton
 *
 * `client.gen.ts` constructs one at import time with a bare `globalThis.fetch`.
 * Using it would put a second, ungated HTTP path in the process, which is
 * locked point 7's whole subject. It is regenerated output and is left alone;
 * the client here is constructed from `PIPEDRIVE_V2_BASE_URL` instead.
 */

import { Result, ResultAsync, err } from "neverthrow";

import { pdError, type PdError } from "../errors.ts";
import { isPdFailure } from "./failure.ts";
import type { GuardedFetch } from "./guarded-fetch.ts";
import {
	PIPEDRIVE_V1_BASE_URL,
	PIPEDRIVE_V2_BASE_URL,
	redactUrl,
} from "./guarded-fetch.ts";
import { createClient, createConfig } from "./v2/generated/client/index.ts";
import type { Auth, Client } from "./v2/generated/client/index.ts";
import {
	createClient as createV1Client,
	createConfig as createV1Config,
} from "./v1/generated/client/index.ts";
import type { Client as V1Client } from "./v1/generated/client/index.ts";

/**
 * The v2 spec declares two security schemes on every operation — the
 * `x-api-token` header and HTTP bearer — and `setAuthParams` walks both. A bare
 * token would satisfy each in turn and send the credential twice, in two
 * headers, which is one more copy of it on the wire than `pd` has a reason for.
 * Answering only the `apiKey` scheme sends exactly the header ADR-0012 chose.
 */
const apiKeyOnly =
	(token: string) =>
	(auth: Auth): string | undefined =>
		auth.type === "apiKey" ? token : undefined;

const jsonParse = Result.fromThrowable(
	(text: string): unknown => JSON.parse(text),
	() =>
		pdError({
			code: "invalid_response",
			message:
				"Pipedrive returned a body that is not JSON. Retrying will not help.",
		}),
);

/**
 * The shape the generated client returns in its default `responseStyle`,
 * narrowed to the three fields this module reads. It is written out rather than
 * imported because the generated `RequestResult` is generic over an operation
 * and this function deliberately is not.
 */
type ClientResult = {
	data?: unknown;
	error?: unknown;
	response?: Response;
};

/**
 * ADR-0001's retry table ends with *Other 4xx — no retry* and names no variant
 * for one. A GET `pd` composed itself that Pipedrive rejects as malformed is a
 * programmer error that escaped, which is the definition ADR-0001 gives
 * `internal`. It is not `upstream`, which is 5xx and transport only, and not
 * `invalid_response`, which is about a body's shape.
 */
const statusError = (status: number, path: string): PdError => {
	const details = { path, status };
	if (status === 401) {
		return pdError({
			code: "auth",
			message:
				"Pipedrive rejected the API token. A human must supply a valid one.",
			details,
		});
	}
	if (status === 403) {
		return pdError({
			code: "forbidden",
			message:
				"The API token is valid but lacks permission for this resource. A human must grant access.",
			details,
		});
	}
	if (status === 404) {
		return pdError({
			code: "not_found",
			message: "Pipedrive does not have that resource.",
			details,
		});
	}
	return pdError({
		code: "internal",
		message:
			`Pipedrive refused a request pd composed, with status ${status}. ` +
			"This is a bug in pd, not a usage error.",
		details,
	});
};

const readBody = (result: ClientResult): Result<unknown, PdError> => {
	if (result.error !== undefined) {
		// The carrier `guardedFetch` throws already holds an ADR-0001 error object
		// that says what happened and that waiting cannot fix it.
		if (isPdFailure(result.error)) return err(result.error.error);
		const response = result.response;
		return err(
			response === undefined
				? pdError({
						code: "internal",
						message: `pd could not issue a request: ${String(result.error)}`,
					})
				: statusError(response.status, redactUrl(response.url)),
		);
	}

	// `parseAs: "text"` makes `data` a string on every success, including the
	// empty-body branch of the generated client.
	return jsonParse(typeof result.data === "string" ? result.data : "");
};

/**
 * A generated SDK function, seen from here: it takes a `client` and returns the
 * fields form. Every operation in both surfaces matches this, because the
 * generation filter admits only GETs.
 *
 * The client type is a parameter because the two generation jobs emit two
 * `Client` types in two module namespaces (ADR-0007 §1). They are structurally
 * the same, and saying so with a cast would be the one place a v1 operation
 * could be handed the v2 client and reach `/api/v2/users`.
 */
export type SdkCall<TOptions, TClient = Client> = (
	options: TOptions & { client: TClient },
) => Promise<ClientResult>;

export type PipedriveClient = {
	/**
	 * Runs a generated v2 operation and hands back the parsed body as `unknown`.
	 * Validation is the caller's, per ADR-0006 §1 — this function classifies
	 * transport and status, never shape.
	 */
	v2: <TOptions>(
		call: SdkCall<TOptions>,
		options: TOptions,
	) => ResultAsync<unknown, PdError>;
	/** Variable-cost relation call, accounted separately while sharing the gate. */
	relation: <TOptions>(
		call: SdkCall<TOptions>,
		options: TOptions,
	) => ResultAsync<unknown, PdError>;
	/**
	 * The same, for the one v1 operation `pd` calls — `GET /users` (ADR-0007 §1).
	 * It differs from `v2` in its `baseUrl` and in nothing else: both clients are
	 * given the same `guardedFetch`, so a v1 request queues in the same limiter
	 * and decrements the same counter (ADR-0007 §2).
	 */
	v1: <TOptions>(
		call: SdkCall<TOptions, V1Client>,
		options: TOptions,
	) => ResultAsync<unknown, PdError>;
	/** ADR-0011 §9's counter, for the trailer's `requests` field. */
	requests: () => number;
};

export type PipedriveClientOptions = {
	token: string;
	guarded: GuardedFetch;
};

export const createPipedriveClient = ({
	token,
	guarded,
}: PipedriveClientOptions): PipedriveClient => {
	const v2Client: Client = createClient(
		createConfig({
			baseUrl: PIPEDRIVE_V2_BASE_URL,
			fetch: guarded.fetch,
			auth: apiKeyOnly(token),
			parseAs: "text",
			throwOnError: false,
		}),
	);

	const relationClient: Client = createClient(
		createConfig({
			baseUrl: PIPEDRIVE_V2_BASE_URL,
			fetch: guarded.relationFetch,
			auth: apiKeyOnly(token),
			parseAs: "text",
			throwOnError: false,
		}),
	);

	const v1Client: V1Client = createV1Client(
		createV1Config({
			baseUrl: PIPEDRIVE_V1_BASE_URL,
			fetch: guarded.fetch,
			auth: apiKeyOnly(token),
			parseAs: "text",
			throwOnError: false,
		}),
	);

	/**
	 * The generated client only rejects when an interceptor does, and `pd`
	 * installs none. Reaching the rejection path at all is a programmer error —
	 * except for the carrier, which is unwrapped rather than reworded.
	 */
	const run = (call: Promise<ClientResult>): ResultAsync<unknown, PdError> =>
		ResultAsync.fromPromise(call, (cause) =>
			isPdFailure(cause)
				? cause.error
				: pdError({
						code: "internal",
						message: `The generated client rejected unexpectedly: ${String(cause)}`,
					}),
		).andThen(readBody);

	return {
		v2: (call, options) => run(call({ ...options, client: v2Client })),
		relation: (call, options) =>
			run(call({ ...options, client: relationClient })),
		v1: (call, options) => run(call({ ...options, client: v1Client })),
		requests: guarded.dispatches,
	};
};
