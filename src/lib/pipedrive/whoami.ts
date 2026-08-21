/**
 * The identity probe — `GET /v1/users/me`, and the record `pd auth whoami`
 * emits (ADR-0033).
 *
 * It is the one request in `pd` whose purpose is to be spent rather than to
 * fetch data: success **is** the answer to "does this credential still work",
 * and the body is the answer to "whose credential is it". There is no `works`
 * field, because the branch that would set it `false` has no record to hang it
 * on and a caller learns strictly more by reading `code` (ADR-0033 §3).
 *
 * Nothing here touches the cache. A cached "your token works" is a statement
 * about a request that was not made, so `whoami` sits outside ADR-0005's closed
 * list of eight entries rather than inside it as a ninth (ADR-0033 §6).
 *
 * ## Why this is a generator of one page
 *
 * The same reason `single.ts` is: `get` and `list` and `whoami` then share
 * `stream()`, the writer, the trailer and the counters (ADR-0004). A second
 * consuming loop is a second place the exactly-one-trailer invariant can be
 * forgotten.
 *
 * It does not reuse `single()` itself, and the resemblance is close enough to
 * say why. `single()` is written around a record fetched **by id**: the id is in
 * its signature, in its rejection message and in that message's `details`, and
 * it is what lets the message distinguish "no such record" from one `pd` cannot
 * read. This endpoint takes no id and returns no addressable record, so every
 * one of those would have to become a branch inside the path five resources
 * share. The local join before the parse is the second difference, and it has no
 * counterpart there at all.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import {
  CREDENTIAL_TIERS,
  type CredentialIdentity,
} from "../auth/credentials.ts";
import { pdError, type PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import { RecordEnvelope } from "./single.ts";
import { adminFlags } from "./users.ts";
import { getCurrentUser } from "./v1/generated/sdk.gen.ts";
import { structural, type Page } from "./walk.ts";

/**
 * Three groups of fields, in output order, and the shape order **is** the
 * output order (the same property `UserRecord` relies on).
 *
 * 1. The user, shaped exactly as `pd users` shapes one — `id`, `name`, `email`,
 *    `active_flag`, `timezone_name`. An agent holding a deal's `owner_id`
 *    compares it against `id` here with no conversion, which is the comparison
 *    "is this mine" actually is.
 * 2. The company — `company_id`, `company_name`, `company_domain`. This is the
 *    half of "whose token is this" no user record has ever carried.
 * 3. The local join — `tier` and `fingerprint`. Neither command produces the
 *    pair alone: `pd auth status` prints a fingerprint and no name, `/users/me`
 *    returns a name and no fingerprint. With two tokens on one machine it is
 *    what says which cache directory belongs to whom. The fingerprint is
 *    derived and not reversible (ADR-0012 §5), so printing it beside an
 *    identity leaks nothing it did not already leak alone.
 *
 * `is_global_admin` and `is_deal_admin` are **optional here and required on
 * `UserRecord`**, and that is the whole of ADR-0033 §4's exception. On `pd
 * users` an absent entry inside a present `access` means "not an admin"; here
 * the array itself can be missing, which means "not asked", and `false` would
 * state something that was not learned. So `whoami` gets its own record schema
 * rather than loosening the shared one, whose two required booleans ticket 27
 * can still guarantee off `GET /users`.
 *
 * Every soft field is `nullish` rather than `optional`. ADR-0007 §3's rule is
 * that nothing downstream of generation trusts the v1 spec's nullability, and a
 * `null` company domain must not cost a caller the answer to "does my token
 * work". The writer drops `null` and absent alike (ADR-0020 §6), so a tolerated
 * `null` never reaches stdout and the emitted shape is unchanged.
 */
export const WhoamiRecord = z.object({
  id: z.int(),
  name: z.string(),
  email: z.string().nullish(),
  active_flag: z.boolean().nullish(),
  timezone_name: z.string().nullish(),
  is_global_admin: z.boolean().optional(),
  is_deal_admin: z.boolean().optional(),
  company_id: z.int().nullish(),
  company_name: z.string().nullish(),
  company_domain: z.string().nullish(),
  tier: z.enum(CREDENTIAL_TIERS),
  fingerprint: z.string(),
});

export type WhoamiRecord = z.infer<typeof WhoamiRecord>;

/** ADR-0009: singular, and the `record_type` on the emitted line. */
export const WHOAMI_RECORD_TYPE = "whoami";

/** What `--fields` selects over, and what the manifest publishes. */
export const WHOAMI_FIELDS: readonly string[] = Object.keys(WhoamiRecord.shape);

export type WhoamiOptions = {
  client: PipedriveClient;
  /** The local half of the answer, joined onto the live one below. */
  identity: CredentialIdentity;
};

/**
 * `access` counts as **asked** only when the response actually carries a
 * readable value for it. `undefined` and `null` are both "not asked" and both
 * omit the two derived fields; anything else is handed to the shared derivation,
 * which reads an unrecognised shape as "not an admin" exactly as `pd users`
 * does.
 */
const derived = (record: Record<string, unknown>): Record<string, boolean> => {
  const access = record["access"];
  return access === undefined || access === null ? {} : adminFlags(access);
};

/**
 * The live answer plus the local join, assembled before the parse rather than
 * after it, so one schema decides the whole record. A body that is not an
 * object is handed on untouched and fails the gate for the reason it already
 * did.
 */
const join = (raw: unknown, identity: CredentialIdentity): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  return { ...record, ...derived(record), ...identity };
};

/**
 * A rejected identity record ends the run, on `single.ts`'s reasoning: the
 * rejected record **is** the answer, so `emitted: 0` with `complete: true` would
 * report that the caller has no identity, which is not what happened. It is not
 * `auth` either — the credential authenticated, and saying otherwise would send
 * a human to rotate a token that works.
 */
const unreadable = (error: z.ZodError): PdError => {
  const issue = error.issues[0];
  return pdError({
    code: "invalid_response",
    message:
      "The identity Pipedrive returned for this credential is not one pd can read. " +
      "Retrying will not help.",
    details: {
      resource: WHOAMI_RECORD_TYPE,
      path: (issue?.path ?? []).join("."),
      issue: issue?.code ?? "invalid_type",
    },
  });
};

export async function* whoamiPages({
  client,
  identity,
}: WhoamiOptions): AsyncGenerator<
  Result<Page<Record<string, unknown>>, PdError>
> {
  const body = await client.v1(getCurrentUser, { url: "/users/me" as const });
  if (body.isErr()) {
    yield err(body.error);
    return;
  }

  const envelope = RecordEnvelope.safeParse(body.value);
  if (!envelope.success) {
    yield err(
      structural(
        "Pipedrive returned an identity body pd cannot read. Retrying will not help.",
        envelope.error,
      ),
    );
    return;
  }

  const parsed = WhoamiRecord.safeParse(join(envelope.data.data, identity));
  if (!parsed.success) {
    yield err(unreadable(parsed.error));
    return;
  }

  // No `bound`: one record is never a bounded answer, so the trailer reads
  // `complete: true`.
  yield ok({ records: [parsed.data], warnings: [], duplicates: 0 });
}
