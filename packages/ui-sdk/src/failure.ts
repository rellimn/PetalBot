import { FAILURE_REASONS, type Failure, type FailureReason } from '@petalbot/sdk';

/** Return undefined to use the SDK category's user-facing fallback. */
export type FailurePresenter<F extends Failure> = (failure: F) => string | undefined;

const FALLBACKS = {
  unsupported: 'This action is not supported.',
  forbidden: 'This action is not allowed.',
  'not-found': 'The requested item could not be found.',
  'rate-limited': 'Too many requests. Please try again later.',
  'platform-error': 'The external service could not complete the action.',
  custom: 'The action could not be completed.',
} satisfies Record<FailureReason, string>;

/** Present an expected failure without falling back to developer diagnostics. */
export function presentFailure<F extends Failure>(
  failure: F,
  presenter?: FailurePresenter<F>,
): string {
  return presenter?.(failure) ?? FALLBACKS[failure.reason];
}

const reasons: ReadonlySet<string> = new Set(FAILURE_REASONS);

/** Recognizes already decoded envelopes; operation validation still belongs to its schema. */
export function isFailure(value: unknown): value is Failure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === false &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    reasons.has(value.reason) &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error &&
    typeof value.error.code === 'string'
  );
}
