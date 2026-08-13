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
 * it exists for. `email`, `active_flag`, `is_deleted` and `timezone_name` are
 * kept because they are the fields a human asks about a user; every other field
 * the v1 response carries is stripped by ADR-0006's unknown-key rule.
 */
export const UserRecord = z.object({
  id: z.int(),
  name: z.string(),
  email: z.string().optional(),
  active_flag: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  timezone_name: z.string().optional(),
});

export type UserRecord = z.infer<typeof UserRecord>;

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
