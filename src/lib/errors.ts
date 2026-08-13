/**
 * The error union — ADR-0001.
 *
 * Errors are values, never thrown (`neverthrow`). This module owns three things
 * and nothing else: the closed set of `code` values, the two static tables that
 * map a `code` to its exit code and its `retry` answer, and the constructor that
 * builds the object ADR-0001 §"The error object" fixes.
 *
 * It deliberately does **not** own the NDJSON trailer — `complete`, `emitted`,
 * `skipped` and the rest belong to the writer of ADR-0004, which ticket 05
 * builds. An error object here is the payload that writer wraps.
 *
 * `unsupported_runtime` is absent on purpose: ADR-0021 §7 withdrew it.
 */

/** ADR-0001, twelve variants: eleven plus `write_blocked` from ADR-0013 §4. */
export const ERROR_CODES = [
  "usage",
  "auth",
  "forbidden",
  "not_found",
  "rate_limited",
  "budget_exhausted",
  "request_ceiling",
  "blocked",
  "upstream",
  "invalid_response",
  "internal",
  "write_blocked",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** *Will repeating the identical command succeed, and when?* — ADR-0001. */
export type Retry = "never" | "after" | "not_today";

export type ExitCode = 1 | 2 | 3;

/**
 * One row per variant, so adding a variant is one edit rather than two that must
 * agree. `request_ceiling` is `never` despite appearances: repeating the
 * identical command hits the identical ceiling.
 */
const VARIANTS: Record<ErrorCode, { exit: ExitCode; retry: Retry }> = {
  usage: { exit: 2, retry: "never" },
  auth: { exit: 1, retry: "never" },
  forbidden: { exit: 1, retry: "never" },
  not_found: { exit: 1, retry: "never" },
  rate_limited: { exit: 3, retry: "after" },
  budget_exhausted: { exit: 3, retry: "not_today" },
  request_ceiling: { exit: 3, retry: "never" },
  blocked: { exit: 3, retry: "not_today" },
  upstream: { exit: 1, retry: "after" },
  invalid_response: { exit: 1, retry: "never" },
  internal: { exit: 1, retry: "never" },
  write_blocked: { exit: 1, retry: "never" },
};

export const exitCodeFor = (code: ErrorCode): ExitCode => VARIANTS[code].exit;
export const retryFor = (code: ErrorCode): Retry => VARIANTS[code].retry;

/**
 * `code`, `message`, `exit_code` and `retry` are on every error in every
 * variant. `retry_after_seconds` appears only when `retry` is `after`.
 * `details` is explicitly unstable and may never be branched on.
 */
export type PdError = {
  code: ErrorCode;
  message: string;
  exit_code: ExitCode;
  retry: Retry;
  retry_after_seconds?: number;
  details?: Record<string, unknown>;
};

export type PdErrorInput = {
  code: ErrorCode;
  message: string;
  /** Only meaningful when the code's `retry` is `after`; ignored otherwise. */
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
};

export const pdError = ({
  code,
  message,
  retryAfterSeconds,
  details,
}: PdErrorInput): PdError => {
  const retry = retryFor(code);
  return {
    code,
    message,
    exit_code: exitCodeFor(code),
    retry,
    ...(retry === "after" && retryAfterSeconds !== undefined
      ? { retry_after_seconds: retryAfterSeconds }
      : {}),
    ...(details === undefined ? {} : { details }),
  };
};
