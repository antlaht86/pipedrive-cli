/**
 * What `pd` asks of a record, and where a generated schema is still believed.
 *
 * ADR-0029 §1 draws the line at **use**: a value `pd` acts on is validated, a
 * value `pd` only copies to stdout is not. A record's interior is the second
 * kind on every resource, so the schemas below ask for identity and nothing
 * else.
 */

import { z } from "zod";

/** A zod object whose output is known while its ordered shape remains inspectable. */
export type ObjectSchema<T> = z.ZodType<T, unknown> & {
	readonly shape: z.ZodRawShape;
};

/**
 * A generated schema used for its field names alone — ADR-0029 §3.
 *
 * `zGetDealsItem` is a good description of what a deal *usually* has and a bad
 * description of what it *always* has. That makes it the right source for the
 * `--fields` vocabulary and the manifest's selectable lists, and the wrong
 * thing to reject a record with. Only `.shape` is read, so the type asks for
 * nothing more and the five differently-typed generated schemas need no cast to
 * sit in one table.
 */
export type FieldVocabulary = { readonly shape: z.ZodRawShape };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `z.custom` rather than `z.looseObject` — ADR-0029 §4.
 *
 * A zod **object** parse reconstructs its value, and reconstruction can reorder
 * keys: declared shape first, unknown keys after. ADR-0002 makes the key order
 * on a `record` line the key order on the wire, so a reconstruction would
 * quietly break the output contract on every record.
 *
 * `z.custom` runs a predicate and returns the same object reference. Nothing is
 * copied, nothing is reordered, nothing is dropped, and no spec `default`
 * fires.
 */
export const IdentifiedRecord = z.custom<Record<string, unknown> & { id: number }>(
	(value) => isObject(value) && Number.isInteger(value["id"]),
	"The record is not an object with an integer id.",
);

/**
 * The same gate for a cached source, whose identity is not always an integer
 * `id`: `fields` keys on a string `field_code` (ADR-0009 §3). The source already
 * owns a `key` that recovers identity from an unvalidated record, so the gate is
 * built from it rather than duplicating the rule.
 */
export const identifiedBy = (
	key: (raw: unknown) => string | number | undefined,
): z.ZodType<Record<string, unknown>, unknown> =>
	z.custom<Record<string, unknown>>(
		(value) => isObject(value) && key(value) !== undefined,
		"The record is not an object with a usable identity.",
	);
