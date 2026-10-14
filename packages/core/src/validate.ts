import type { z } from 'zod';
import { ValidationError } from '@petalbot/sdk';

/** Parses `value` with `schema`; throws ValidationError naming `subject` on failure. */
export function parseOrThrow(schema: z.ZodType, value: unknown, subject: string): unknown {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(subject, result.error.issues);
  return result.data;
}
