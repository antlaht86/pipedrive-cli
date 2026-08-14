import type { z } from "zod";

/** A zod object whose output is known while its ordered shape remains inspectable. */
export type ObjectSchema<T> = z.ZodType<T, unknown> & {
  readonly shape: z.ZodRawShape;
};
