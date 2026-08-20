import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/** Parse zero or one positional argument and reject the complete remaining vector. */
export const parseOptionalSingleArgument = <Value>(
	args: readonly string[],
	valueSchema: z.ZodType<Value>,
	defaultValue: Value,
): Result<Value, string> => {
	const schema = z.union([z.tuple([]), z.tuple([valueSchema])]);
	const parsed = schema.safeParse(args);
	if (!parsed.success) return err(parsed.error.message);
	return ok(parsed.data[0] ?? defaultValue);
};

/** Parse exactly one positional argument and reject the complete remaining vector. */
export const parseRequiredSingleArgument = <Value>(
	args: readonly string[],
	valueSchema: z.ZodType<Value>,
): Result<Value, string> => {
	const parsed = z.tuple([valueSchema]).safeParse(args);
	return parsed.success ? ok(parsed.data[0]) : err(parsed.error.message);
};
