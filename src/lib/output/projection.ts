import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { pdError, type PdError } from "../errors.ts";
import type { PdWarning } from "../warnings.ts";
import type { Page } from "../pipedrive/walk.ts";

const CustomFieldHash = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .brand<"CustomFieldHash">();

type CustomFieldHash = z.infer<typeof CustomFieldHash>;

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

type ParsedSelector =
  | { kind: "top-level"; raw: string }
  | { kind: "custom-field"; hash: CustomFieldHash };

const selectorSchema = (
  outputToRaw: ReadonlyMap<string, string>,
  valid: readonly string[],
) =>
  z.string().transform((selector, context): ParsedSelector => {
    const correction = RESOLUTION_ARTIFACTS[selector];
    if (correction !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          `--fields cannot select ${selector}; it is a resolution artifact. ` +
          `Select ${correction} instead.`,
      });
      return z.NEVER;
    }

    if (selector.startsWith("custom_fields.")) {
      const parsedHash = CustomFieldHash.safeParse(
        selector.slice("custom_fields.".length),
      );
      if (parsedHash.success && outputToRaw.has("custom_fields")) {
        return { kind: "custom-field", hash: parsedHash.data };
      }
    }

    const raw = outputToRaw.get(selector);
    if (raw !== undefined) return { kind: "top-level", raw };

    context.addIssue({
      code: "custom",
      message:
        `pd does not have a selectable field '${selector}'. Valid fields: ` +
        `${valid.join(", ")}. Custom fields use ` +
        "custom_fields.<40-character-hash>.",
    });
    return z.NEVER;
  });

/** One zod boundary for repeatable values, CSV syntax and contextual selectors. */
const fieldArgumentsSchema = (
  outputToRaw: ReadonlyMap<string, string>,
  valid: readonly string[],
) =>
  z
    .array(z.string())
    .transform((values, context) => {
      const selectors: string[] = [];
      const seen = new Set<string>();
      for (const value of values) {
        for (const selector of value.split(",")) {
          if (selector === "") {
            context.addIssue({
              code: "custom",
              message: "--fields contains an empty field name.",
            });
            return z.NEVER;
          }
          if (!seen.has(selector)) {
            seen.add(selector);
            selectors.push(selector);
          }
        }
      }
      return selectors;
    })
    .pipe(z.array(selectorSchema(outputToRaw, valid)));

export type Projection = {
  /** A comma-separated value suitable for Pipedrive's subtractive query parameter. */
  readonly pushdown: string | undefined;
  readonly apply: (record: Record<string, unknown>) => Record<string, unknown>;
  readonly unmatched: () => readonly CustomFieldHash[];
};

export const createProjection = (
  given: readonly string[] | undefined,
  schemaFields: readonly string[],
  rename: Readonly<Record<string, string>> = {},
  identityField = "id",
): Result<Projection | undefined, PdError> => {
  if (given === undefined) return ok(undefined);

  const outputToRaw = new Map(
    schemaFields.map((raw) => [rename[raw] ?? raw, raw]),
  );
  const valid = [...outputToRaw.keys()];
  const parsed = fieldArgumentsSchema(outputToRaw, valid).safeParse(given);
  if (!parsed.success) {
    return err(
      pdError({
        code: "usage",
        message:
          parsed.error.issues[0]?.message ?? "Invalid --fields value.",
      }),
    );
  }

  // `field_code` is the id of a `field` resource (ADR-0009 §3); every other
  // resource uses `id`. Keeping the source's identity makes every projected
  // record followable without inventing a second identifier on field records.
  const rawSelected = new Set<string>([identityField]);
  const hashes: CustomFieldHash[] = [];
  let wholeCustomFields = false;

  for (const selector of parsed.data) {
    if (selector.kind === "custom-field") {
      hashes.push(selector.hash);
      rawSelected.add("custom_fields");
      continue;
    }
    rawSelected.add(selector.raw);
    if (selector.raw === "custom_fields") wholeCustomFields = true;
  }

  const sortedHashes = [...hashes].sort();
  const matched = new Set<CustomFieldHash>();

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

        const source =
          value !== null && typeof value === "object"
            ? (value as Record<string, unknown>)
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

const warning = (selector: CustomFieldHash): PdWarning => ({
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
        warnings: [
          ...projected.warnings,
          ...projection.unmatched().map(warning),
        ],
      });
      return;
    }
    yield ok(projected);
  }

  const warnings = projection.unmatched().map(warning);
  if (warnings.length > 0) yield ok({ records: [], warnings, duplicates: 0 });
}
