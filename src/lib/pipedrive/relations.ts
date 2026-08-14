import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { PdError } from "../errors.ts";
import type { PipedriveClient } from "./client.ts";
import { structural } from "./walk.ts";
import { getOrganizations, getPersons } from "./v2/generated/sdk.gen.ts";

export type Relation = "persons" | "organizations";

/** One mapping shared by relation collection and custom-field labelling. */
export const relationOfFieldType = (fieldType: string): Relation | undefined => {
  switch (fieldType) {
    case "person":
    case "people":
      return "persons";
    case "organization":
    case "org":
      return "organizations";
    default:
      return undefined;
  }
};

export const rawFieldOf = (relation: Relation): "person_id" | "org_id" =>
  relation === "persons" ? "person_id" : "org_id";

const NamedRelation = z.object({ id: z.int(), name: z.string() });
const RelationEnvelope = z.object({
  success: z.boolean(),
  data: z.array(NamedRelation),
});

/** Fetches one API-supported batch and validates it at the HTTP boundary. */
export const fetchRelationNames = async (
  client: PipedriveClient,
  relation: Relation,
  ids: readonly number[],
): Promise<Result<ReadonlyMap<number, string>, PdError>> => {
  const response = await (relation === "persons"
    ? client.relation(getPersons, { query: { ids: ids.join(",") } })
    : client.relation(getOrganizations, { query: { ids: ids.join(",") } }));
  if (response.isErr()) return err(response.error);

  const parsed = RelationEnvelope.safeParse(response.value);
  if (!parsed.success) {
    return err(
      structural(
        `Pipedrive returned an invalid ${relation} relation response.`,
        parsed.error,
      ),
    );
  }
  return ok(new Map(parsed.data.data.map((record) => [record.id, record.name])));
};
