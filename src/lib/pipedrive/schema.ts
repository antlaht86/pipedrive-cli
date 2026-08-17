/**
 * What `pd` asks of a record, and where a generated schema is still believed.
 *
 * ADR-0029 §1 draws the line at **use**: a value `pd` acts on is validated, a
 * value `pd` only copies to stdout is not. A record's interior is the second
 * kind on every resource, so the schemas below ask for identity and nothing
 * else.
 */

import { z } from "zod";

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
 * A record's identity, read out of a value nothing has validated yet.
 *
 * It is deliberately narrow: anything that is not an object carrying the right
 * primitive under the right key has no identity, and a record with no identity
 * is the only kind ADR-0029 §5 still rejects. Deduplication keys on it, `get`
 * matches on it, and a rejected record's best-effort `id` is recovered through
 * it — so it is written once here rather than three times with one of them
 * subtly different.
 */
export type Identity = (raw: unknown) => string | number | undefined;

/** Every resource but `fields`, whose id is a string (ADR-0009 §3). */
export const integerId: Identity = (raw) => {
	const value = isObject(raw) ? raw["id"] : undefined;
	return typeof value === "number" && Number.isInteger(value)
		? value
		: undefined;
};

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
export const identifiedBy = (
	key: Identity,
): z.ZodType<Record<string, unknown>, unknown> =>
	z.custom<Record<string, unknown>>(
		(value) => key(value) !== undefined,
		"The record carries no identity pd can read.",
	);

/**
 * The gate the five live resources walk behind. The assertion is the one place
 * the identity rule and the type stating it meet: `integerId` looked at `id`,
 * and no signature can tell TypeScript that it did.
 */
export const IdentifiedRecord = identifiedBy(integerId) as z.ZodType<
	Record<string, unknown> & { id: number },
	unknown
>;
