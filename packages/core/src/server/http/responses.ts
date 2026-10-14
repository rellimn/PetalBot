import type { z } from 'zod';
import type { WireErrorCode } from '../errors.ts';
import { SESSION_SECURITY } from './cookies.ts';
import { errorBodySchema } from './schemas.ts';

export const SECURITY = [{ [SESSION_SECURITY]: [] }];

const DESCRIPTIONS = {
  400: 'Invalid request (code validation or auth_failed)',
  401: 'Not logged in',
  403: 'Insufficient role or failed Origin check',
  404: 'Not found',
  409: 'Conflicts with the current state (conflict, unavailable or confirmation_required)',
  413: 'Request body larger than 1 MiB',
  503: 'A required service is unavailable',
} as const;

type ErrorStatus = keyof typeof DESCRIPTIONS;

interface JsonResponse<S extends z.ZodType> {
  readonly description: string;
  readonly content: { readonly 'application/json': { readonly schema: S } };
}

export function json<S extends z.ZodType>(schema: S, description: string): JsonResponse<S> {
  return { description, content: { 'application/json': { schema } } };
}

/** Error responses for `createRoute`; all share the ErrorBody schema. */
export function errors<const S extends readonly ErrorStatus[]>(
  ...statuses: S
): Readonly<Record<S[number], JsonResponse<typeof errorBodySchema>>> {
  return Object.fromEntries(
    statuses.map((status) => [status, json(errorBodySchema, DESCRIPTIONS[status])]),
  ) as never;
}

export interface WireIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export function toWireIssues(issues: readonly z.core.$ZodIssue[]): WireIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
    message: issue.message,
  }));
}

export function errorBody(
  code: WireErrorCode,
  message: string,
  plugins?: readonly string[],
  issues?: readonly WireIssue[],
) {
  return {
    error: { code, message, ...(plugins ? { plugins } : {}), ...(issues ? { issues } : {}) },
  };
}
