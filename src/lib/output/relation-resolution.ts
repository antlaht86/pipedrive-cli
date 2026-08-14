import { z } from "zod";

import type { PipedriveClient } from "../pipedrive/client.ts";
import { fetchRelationNames, type Relation } from "../pipedrive/relations.ts";
import type { NdjsonWriter } from "./ndjson-writer.ts";

export type RelationLookups = Record<Relation, Map<number, string>>;

export type RelationField = {
  field_type: string;
};

type Context = {
  client: PipedriveClient;
  writer: NdjsonWriter;
  budget: number;
  lookups: RelationLookups;
  fields: () => ReadonlyMap<string, RelationField>;
  unavailable: (relation: Relation) => void;
};

const relationShape = (relation: Relation) =>
  relation === "persons"
    ? { rawField: "person_id", fieldTypes: new Set(["person", "people"]) }
    : { rawField: "org_id", fieldTypes: new Set(["organization", "org"]) };

const unresolvedIds = (
  records: readonly Record<string, unknown>[],
  relation: Relation,
  lookups: RelationLookups,
  fields: ReadonlyMap<string, RelationField>,
): number[] => {
  const ids = new Set<number>();
  const { rawField, fieldTypes } = relationShape(relation);
  const known = lookups[relation];
  for (const record of records) {
    const standard = z.int().safeParse(record[rawField]);
    if (standard.success && !known.has(standard.data)) ids.add(standard.data);

    const custom = record.custom_fields;
    if (custom === null || typeof custom !== "object" || Array.isArray(custom)) continue;
    for (const [hash, value] of Object.entries(custom as Record<string, unknown>)) {
      const fieldType = fields.get(hash)?.field_type;
      if (fieldType === undefined || !fieldTypes.has(fieldType)) continue;
      const parsed = z.int().safeParse(value);
      if (parsed.success && !known.has(parsed.data)) ids.add(parsed.data);
    }
  }
  return [...ids];
};

/** Run-scoped, page-fed relation enrichment with its own soft request ceiling. */
export const createRelationResolution = ({
  client,
  writer,
  budget,
  lookups,
  fields,
  unavailable,
}: Context): ((records: readonly Record<string, unknown>[]) => Promise<void>) => {
  const unavailableRelations = new Set<Relation>();
  let requests = 0;
  let stopped = false;
  let budgetWarned = false;

  const exhaustBudget = (): void => {
    stopped = true;
    writer.resolutionPartial();
    if (budgetWarned) return;
    budgetWarned = true;
    writer.warn({
      kind: "resolution_budget_exhausted",
      message: "Relation resolution stopped at the request ceiling; ids are unresolved.",
    });
  };

  const fetchBatches = async (
    relation: Relation,
    ids: readonly number[],
  ): Promise<void> => {
    if (unavailableRelations.has(relation) || stopped) return;
    for (let offset = 0; offset < ids.length; offset += 100) {
      if (requests >= budget || !client.canDispatchEnrichment()) {
        exhaustBudget();
        return;
      }
      requests += 1;
      const response = await fetchRelationNames(
        client,
        relation,
        ids.slice(offset, offset + 100),
      );
      if (response.isErr()) {
        unavailableRelations.add(relation);
        unavailable(relation);
        return;
      }
      for (const [id, name] of response.value) lookups[relation].set(id, name);
    }
  };

  return async (records): Promise<void> => {
    for (const relation of ["persons", "organizations"] as const) {
      await fetchBatches(
        relation,
        unresolvedIds(records, relation, lookups, fields()),
      );
    }
  };
};
