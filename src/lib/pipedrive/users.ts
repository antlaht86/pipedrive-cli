/**
 * The v1 `users` fetch, and the record schema `pd` owns — ADR-0007 §3.
 *
 * The generated schema marks all twenty fields required, because
 * `propertiesRequiredByDefault: true` is set and the v1 spec declares only
 * `phone`, `modified` and `icon_url` nullable. That is a claim about a real CRM
 * nobody has verified, and a deactivated colleague who never logged in is a
 * plausible counterexample for `last_login`. So `pd` defines the record itself
 * and nothing downstream of generation trusts the v1 spec — which is also why
 * the v1 job carries no `parser.patch`.
 *
 * `GET /users` is unpaginated (ADR-0007 §"Context"): zero parameters, the whole
 * collection in one response, no `start`, no `next_start`, no
 * `more_items_in_collection`. There is nothing here for a cursor walk to do,
 * which is why this module fetches rather than walking.
 *
 * Deactivated and deleted users are included. `owner_id` on a two-year-old deal
 * frequently points at a colleague who has left, and a resolver that cannot name
 * them fails at exactly the moment the name is most needed (ADR-0007 §5).
 */

import { ResultAsync, err, ok } from "neverthrow";
import { z } from "zod";

import type { PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import { structural } from "./walk.ts";
import { getUsers } from "./v1/generated/sdk.gen.ts";

/**
 * `id` and `name` are required — without them the record cannot do the one job
 * it exists for. `email`, `active_flag`, `is_deleted`, `timezone_name` and
 * `access` are kept because they are the fields a human asks about a user;
 * every other field the v1 response carries is dropped, because this is a
 * `z.object` and zod strips what a shape does not declare.
 *
 * `access` is the one member `pd` never reads. It arrives as an array of
 * `{ app, admin, permission_set_id }`, and it answers "who administers this
 * account" — the question `pd users list` could not answer before. ADR-0029 §1
 * validates what `pd` acts on and passes through what `pd` only emits, so it is
 * declared as `z.unknown()`: enough to stop the strip, not enough to reject. An
 * `app` enum would be the opposite trade — a Pipedrive product launch would
 * fail the gate, and a failed gate drops the user from `--resolve` as well as
 * from stdout, which is precisely the naming failure ADR-0007 §5 exists to
 * prevent.
 *
 * `is_global_admin` and `is_deal_admin` are derived from `access` rather than
 * read off the wire, and they are the one place `pd` looks **inside** a record
 * on this resource (ADR-0029 §1, amended by ticket 27). They answer the
 * question `access` only contains: a caller would otherwise have to know the
 * app is spelled `sales` and not `deals`, and that an absent entry means "not
 * an admin" rather than `admin: false`. The name says `deal` because
 * Pipedrive's own UI calls the role "deal admin".
 *
 * That makes `users` the one resource whose output is still closed. ADR-0029 §6
 * opened the other nine by taking their generated schemas out of the record
 * path; this one is hand-written, `pd` reads `id` and `name` out of it to
 * resolve owners, and ADR-0029 §2 keeps it for exactly that reason.
 */
export const UserRecord = z.object({
  id: z.int(),
  name: z.string(),
  email: z.string().optional(),
  active_flag: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  timezone_name: z.string().optional(),
  access: z.unknown().optional(),
  is_global_admin: z.boolean(),
  is_deal_admin: z.boolean(),
});

export type UserRecord = z.infer<typeof UserRecord>;

/**
 * One `access` entry, read as leniently as the derivation allows: `app` is a
 * string and `admin` is a boolean, with no enum over either. An entry that does
 * not read this way is data the derivation skips, never a reason to reject the
 * record — an unrecognised `app` value is a Pipedrive product launch, and
 * ADR-0007 §5 keeps a name through one of those.
 */
const AccessEntry = z.object({ app: z.string(), admin: z.boolean() });

/** True when `access` names `app` with `admin: true`. Absence reads as false. */
const administers = (access: unknown, app: string): boolean =>
  Array.isArray(access) &&
  access.some((entry) => {
    const parsed = AccessEntry.safeParse(entry);
    return parsed.success && parsed.data.app === app && parsed.data.admin;
  });

/**
 * The two booleans, injected before the record is parsed rather than defaulted
 * inside it: they are always present and always a boolean, including on a
 * record that carries no `access` at all and on one whose `access` is not a
 * readable list. A non-object is handed on untouched, so it fails the gate for
 * the reason it already did.
 */
const withAdminFlags = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  return {
    ...record,
    is_global_admin: administers(record["access"], "global"),
    is_deal_admin: administers(record["access"], "sales"),
  };
};

/**
 * The two roles `pd users list --admin` selects on, and the derived boolean
 * each one reads. The vocabulary is `global` and `deal` — the spelling of the
 * fields above and of Pipedrive's own UI — and `sales` is not a synonym for
 * `deal` here: the wire word stays on the wire (ticket 28).
 */
export const ADMIN_SCOPES = ["global", "deal"] as const;

export type AdminScope = (typeof ADMIN_SCOPES)[number];

export const ADMIN_FIELD: Readonly<Record<AdminScope, keyof UserRecord>> = {
  global: "is_global_admin",
  deal: "is_deal_admin",
};

/**
 * The gate `cached.ts` admits a user record with, and the only schema that
 * should ever meet a raw wire record: `UserRecord` alone no longer parses one,
 * because it now requires two fields Pipedrive does not send. `UserRecord`
 * stays the field vocabulary — its shape order is the output key order — and
 * the derived booleans sit at the end of it, so the six older keys and `access`
 * keep their positions (ADR-0007 §7: resolution adds, it never removes).
 */
export const UserGate: z.ZodType<Record<string, unknown>, unknown> =
  z.preprocess(withAdminFlags, UserRecord);

/**
 * ADR-0007 §3: `{ success, data }` with no `additional_data` member, validated
 * strictly, with the elements left as `unknown` for the record schema one stage
 * later. It is not `ListEnvelope`: that schema describes a v2 cursor page, and
 * accepting one here would mean accepting a `next_cursor` this endpoint cannot
 * produce.
 */
const UsersEnvelope = z.object({
  success: z.boolean(),
  data: z.array(z.unknown()),
});

/** The raw user records, exactly as v1 returned them. One request, always. */
export const fetchUsers = (
  client: PipedriveClient,
): ResultAsync<unknown[], PdError> =>
  client.v1(getUsers, { url: "/users" as const }).andThen((body) => {
    const envelope = UsersEnvelope.safeParse(body);
    return envelope.success
      ? ok(envelope.data.data)
      : err(
          structural(
            "Pipedrive returned a user list pd cannot read. Retrying will not help.",
            envelope.error,
          ),
        );
  });
