import { describe, expect, it } from 'vitest';
import { isFailure, presentFailure } from '../src/failure.ts';

describe('user-facing failure presentation', () => {
  it.each([
    ['unsupported', 'This action is not supported.'],
    ['forbidden', 'This action is not allowed.'],
    ['not-found', 'The requested item could not be found.'],
    ['rate-limited', 'Too many requests. Please try again later.'],
    ['platform-error', 'The external service could not complete the action.'],
    ['custom', 'The action could not be completed.'],
  ] as const)('presents the %s category without reading diagnostics', (reason, text) => {
    expect(
      presentFailure({
        ok: false,
        reason,
        error: { code: 'domain-code' },
        get message(): string {
          throw new Error('must not read diagnostics');
        },
      }),
    ).toBe(text);
  });

  it('uses explicit presenters, with undefined as the only fallback', () => {
    const failure = {
      ok: false as const,
      reason: 'not-found' as const,
      error: { code: 'missing', id: 'a' },
      message: 'DIAGNOSTIC_ONLY',
    };
    expect(presentFailure(failure, (f) => `Choose another ${f.error.id}.`)).toBe(
      'Choose another a.',
    );
    expect(presentFailure(failure, () => undefined)).toBe('The requested item could not be found.');
    expect(presentFailure(failure, () => '')).toBe('');
    expect(() =>
      presentFailure(failure, () => {
        throw new Error('presenter bug');
      }),
    ).toThrow('presenter bug');
  });

  it('uses the first presenter that returns text', () => {
    const failure = { ok: false as const, reason: 'custom' as const, error: { code: 'busy' } };
    expect(
      presentFailure(
        failure,
        undefined,
        () => undefined,
        () => 'Second.',
      ),
    ).toBe('Second.');
    expect(
      presentFailure(
        failure,
        () => 'First.',
        () => 'Second.',
      ),
    ).toBe('First.');
    expect(presentFailure(failure, undefined, () => undefined)).toBe(
      'The action could not be completed.',
    );
  });

  it('recognizes message-free envelopes without stripping their payload', () => {
    const value = { ok: false, reason: 'custom', error: { code: 'busy', capacity: 2 } };
    expect(isFailure(value)).toBe(true);
    expect(value.error.capacity).toBe(2);
  });

  it.each([
    null,
    { ok: true },
    { ok: false, message: 'old envelope' },
    { ok: false, reason: 'unknown', error: { code: 'x' } },
    { ok: false, reason: 'custom', error: null },
    { ok: false, reason: 'custom', error: 'x' },
    { ok: false, reason: 'custom', error: { code: 1 } },
  ])('does not treat malformed or unrelated values as SDK failures: %j', (value) => {
    expect(isFailure(value)).toBe(false);
  });
});
