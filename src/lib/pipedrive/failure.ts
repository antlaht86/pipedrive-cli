/**
 * The one place `pd` throws on purpose, and why that is not a violation.
 *
 * `CLAUDE.md` says application code returns `Result` instead of throwing, and
 * wraps third-party throws at the boundary. `guardedFetch` **is** that boundary:
 * the generated SDK calls it as `typeof fetch`, so its return type is
 * `Promise<Response>` and there is no channel on it for a `Result`. A refusal or
 * an exhausted retry budget therefore travels as a throw of this carrier, and
 * the wrapper module converts it back to a `Result` with `fromPromise` — which
 * is the same `fromPromise` boundary rule, applied to a throw `pd` raised rather
 * than one a library did.
 *
 * The carrier holds an ADR-0001 error object and nothing else. It deliberately
 * does not extend `Error`: there is no stack worth keeping and no message worth
 * reading past `error.message`, and not extending `Error` makes an accidental
 * `catch (e) { e.message }` fail loudly instead of quietly producing prose that
 * bypasses the typed union.
 */

import type { PdError } from "../errors.ts";

export class PdFailure {
  constructor(readonly error: PdError) {}
}

export const isPdFailure = (value: unknown): value is PdFailure =>
  value instanceof PdFailure;
