import { z } from 'zod';

export const FAILURE_REASONS = [
  'unsupported',
  'forbidden',
  'not-found',
  'rate-limited',
  'platform-error',
] as const;

/** Closed set. Adding a reason is a major SDK version bump. */
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface Failure {
  ok: false;
  reason: FailureReason;
  message: string;
}

export type Result<T extends object = object> = ({ ok: true } & T) | Failure;

const failureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(FAILURE_REASONS),
  message: z.string(),
});

/** Zod builder for contract outputs: `output: Result(z.object({ messageId: z.string() }))`. */
export function Result<Shape extends z.ZodRawShape>(success: z.ZodObject<Shape>) {
  return z.discriminatedUnion('ok', [
    z.object({ ...success.shape, ok: z.literal(true) }),
    failureSchema,
  ]);
}

export function ok(): { ok: true };
export function ok<T extends object>(value: T): { ok: true } & T;
export function ok(value: object = {}): { ok: true } {
  return { ...value, ok: true };
}

export function fail(reason: FailureReason, message: string): Failure {
  return { ok: false, reason, message };
}
