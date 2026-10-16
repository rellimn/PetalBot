import { z } from 'zod';
import type { IsUnion } from './type-utils.ts';

export const FAILURE_REASONS = [
  'unsupported',
  'forbidden',
  'not-found',
  'rate-limited',
  'platform-error',
  'custom',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export interface Failure {
  ok: false;
  reason: FailureReason;
  error: { code: string };
  message?: string | undefined;
}
// Both directions distinguish Zod's empty object from required fields of type never.
type IsEmpty<T> = [T] extends [Record<string, never>]
  ? [Record<string, never>] extends [T]
    ? true
    : false
  : false;
type Success<T> = IsEmpty<T> extends true ? { ok: true } : { ok: true } & T;
export type Result<T extends object, F extends Failure = never> = Success<T> | F;

// Zod represents an empty detail object as Record<string, never>; it must not forbid code.
type ErrorDetail<C extends string, D> = IsEmpty<D> extends true ? { code: C } : D & { code: C };

interface Envelope<C extends string, R extends FailureReason, D> {
  ok: false;
  reason: R;
  error: ErrorDetail<C, D>;
  message?: string | undefined;
}
export interface FailureDefinition {
  readonly code: string;
  readonly reason: FailureReason;
  readonly schema: z.ZodType<Failure, Failure>;
}
type WithoutKey<S extends z.ZodObject, K extends string> = K extends keyof S['shape']
  ? never
  : unknown;

export function defineFailure<
  const C extends string,
  const R extends FailureReason,
  D extends z.ZodObject,
>(options: { code: C; reason: R; details: D & WithoutKey<D, 'code'> }) {
  const { code, reason, details } = options;
  if (code.length === 0) throw new TypeError('Failure code must not be empty');
  if (Object.hasOwn(details.shape, 'code')) {
    throw new TypeError('Failure details must not declare code');
  }
  const error = details.safeExtend({ code: z.literal(code) });
  // safeExtend preserves checks/codecs; these types retain the concrete detail input/output.
  const schema = z.object({
    ok: z.literal(false),
    reason: z.literal(reason),
    error,
    message: z.string().optional(),
  }) as unknown as z.ZodType<Envelope<C, R, z.output<D>>, Envelope<C, R, z.input<D>>>;
  const definition = { code, reason, schema };
  definitions.set(schema, definition);
  return definition;
}

/** Envelope schemas of `defineFailure`, so contract checks can find them inside any schema. */
const definitions = new WeakMap<z.core.$ZodType, FailureDefinition>();

/**
 * Every failure definition used anywhere inside `schema` (nested in objects, records, unions,
 * pipes and so on). Does not look into `z.lazy`.
 */
export function failuresIn(schema: z.core.$ZodType): Set<FailureDefinition> {
  const found = new Set<FailureDefinition>();
  const seen = new Set<z.core.$ZodType>();
  const visit = (node: z.core.$ZodType): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const definition = definitions.get(node);
    if (definition !== undefined) found.add(definition);
    // Child schemas sit directly in the def, in arrays (union options) or in objects (shape).
    const def = node._zod.def as unknown as Readonly<Record<string, unknown>>;
    for (const value of Object.values(def)) {
      const children = Array.isArray(value)
        ? value
        : typeof value === 'object' && value !== null && !(value instanceof z.core.$ZodType)
          ? Object.values(value)
          : [value];
      for (const child of children) {
        if (child instanceof z.core.$ZodType) visit(child);
      }
    }
  };
  visit(schema);
  return found;
}

export function fail<D extends FailureDefinition>(
  // Narrow a union definition first so its payload stays correlated with its code.
  definition: D & (IsUnion<D> extends false ? unknown : never),
  details: Omit<z.input<NoInfer<D>['schema']>['error'], 'code'> & { code?: never },
  message?: string,
): z.input<D['schema']> {
  return {
    ok: false,
    reason: definition.reason,
    error: { ...details, code: definition.code },
    ...(message === undefined ? {} : { message }),
  } as z.input<D['schema']>;
}

export function Result<S extends z.ZodObject, const F extends readonly FailureDefinition[]>(
  success: S & WithoutKey<S, 'ok'>,
  failures: F,
): z.ZodType<
  Success<z.output<S>> | z.output<F[number]['schema']>,
  Success<z.input<S>> | z.input<F[number]['schema']>
> {
  if (Object.hasOwn(success.shape, 'ok')) {
    throw new TypeError('Success fields must not declare ok');
  }
  const codes = new Set<string>();
  for (const failure of failures) {
    if (codes.has(failure.code)) throw new TypeError(`Duplicate failure code: ${failure.code}`);
    codes.add(failure.code);
  }
  const passed = success.safeExtend({ ok: z.literal(true) });
  // The runtime union contains exactly the declared schemas, including their codec inputs.
  return (failures.length === 0
    ? passed
    : z.union([passed, ...failures.map((failure) => failure.schema)])) as unknown as z.ZodType<
    Success<z.output<S>> | z.output<F[number]['schema']>,
    Success<z.input<S>> | z.input<F[number]['schema']>
  >;
}

export function ok(): { ok: true };
export function ok<T extends object>(value: T): { ok: true } & T;
export function ok(value: object = {}): { ok: true } {
  return { ...value, ok: true };
}
