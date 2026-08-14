import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { PdWarning } from "../warnings.ts";
import type { Page } from "../pipedrive/walk.ts";

const CUSTOM_HASH = /^[0-9a-f]{40}$/i;

const RESOLUTION_ARTIFACTS: Readonly<Record<string, string>> = {
  custom_fields_resolved: "custom_fields",
  owner_name: "owner_id",
  creator_user_name: "creator_user_id",
  user_name: "user_id",
  person_name: "person_id",
  org_name: "org_id",
  pipeline_name: "pipeline_id",
  stage_name: "stage_id",
};

const FieldArguments = z.array(z.string()).transform((values, context) => {
  const selectors: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const selector of value.split(",")) {
      if (selector === "") {
        context.addIssue({ code: "custom", message: "--fields contains an empty field name." });
        return z.NEVER;
      }
      if (!seen.has(selector)) {
        seen.add(selector);
        selectors.push(selector);
      }
    }
  }
  return selectors;
});

export type Projection = {
  /** A comma-separated value suitable for Pipedrive's subtractive query parameter. */
  readonly pushdown: string | undefined;
  readonly apply: (record: Record<string, unknown>) => Record<string, unknown>;
  readonly unmatched: () => readonly string[];
};

const validList = (fields: readonly string[]): string => fields.join(", ");

export const createProjection = (
  given: readonly string[] | undefined,
  schemaFields: readonly string[],
  rename: Readonly<Record<string, string>> = {},
): Result<Projection | undefined, PdError> => {
  if (given === undefined) return ok(undefined);

  const parsed = FieldArguments.safeParse(given);
  if (!parsed.success) {
    return err(pdError({ code: "usage", message: parsed.error.issues[0]?.message ?? "Invalid --fields value." }));
  }

  const outputToRaw = new Map(schemaFields.map((raw) => [rename[raw] ?? raw, raw]));
  const valid = [...outputToRaw.keys()];
  const rawSelected = new Set<string>(["id"]);
  const hashes: string[] = [];
  let wholeCustomFields = false;

  for (const selector of parsed.data) {
    const correction = RESOLUTION_ARTIFACTS[selector];
    if (correction !== undefined) {
      return err(pdError({
        code: "usage",
        message: `--fields cannot select ${selector}; it is a resolution artifact. Select ${correction} instead.`,
      }));
    }

    if (selector.startsWith("custom_fields.")) {
      const hash = selector.slice("custom_fields.".length);
      if (CUSTOM_HASH.test(hash) && outputToRaw.has("custom_fields")) {
        hashes.push(hash);
        rawSelected.add("custom_fields");
        continue;
      }
    }

    const raw = outputToRaw.get(selector);
    if (raw === undefined) {
      return err(pdError({
        code: "usage",
        message: `pd does not have a selectable field '${selector}'. Valid fields: ${validList(valid)}. Custom fields use custom_fields.<40-character-hash>.`,
        details: { field: selector, valid_fields: valid },
      }));
    }
    rawSelected.add(raw);
    if (raw === "custom_fields") wholeCustomFields = true;
  }

  const sortedHashes = [...hashes].sort();
  const matched = new Set<string>();

  return ok({
    pushdown:
      !wholeCustomFields && sortedHashes.length > 0 && sortedHashes.length <= 15
        ? sortedHashes.join(",")
        : undefined,
    apply: (record) => {
      const projected: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!rawSelected.has(key)) continue;
        if (key !== "custom_fields" || wholeCustomFields) {
          projected[key] = value;
          continue;
        }

        const source = value !== null && typeof value === "object"
          ? value as Record<string, unknown>
          : {};
        const selected: Record<string, unknown> = {};
        for (const hash of sortedHashes) {
          if (!Object.hasOwn(source, hash)) continue;
          matched.add(hash);
          selected[hash] = source[hash];
        }
        projected[key] = selected;
      }
      return projected;
    },
    unmatched: () => sortedHashes.filter((hash) => !matched.has(hash)),
  });
};

const warning = (selector: string): PdWarning => ({
  kind: "unmatched_field_selector",
  selector: `custom_fields.${selector}`,
  message: `The custom field selector custom_fields.${selector} matched no record in this run.`,
});

/** Validation has already happened in the source generator; projection is the next stage. */
export async function* projectPages(
  pages: AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>>,
  projection: Projection | undefined,
): AsyncGenerator<Result<Page<Record<string, unknown>>, PdError>> {
  if (projection === undefined) {
    yield* pages;
    return;
  }

  for await (const page of pages) {
    if (page.isErr()) {
      yield page;
      return;
    }
    const projected = {
      ...page.value,
      records: page.value.records.map(projection.apply),
    };
    // `stream` stops consuming as soon as a bound page is yielded, so its
    // run-level warnings must ride that final page rather than a later one.
    if (projected.bound !== undefined) {
      yield ok({
        ...projected,
        warnings: [...projected.warnings, ...projection.unmatched().map(warning)],
      });
      return;
    }
    yield ok(projected);
  }

  const warnings = projection.unmatched().map(warning);
  if (warnings.length > 0) yield ok({ records: [], warnings, duplicates: 0 });
}
