import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Result, fail, ok } from '../src/result.ts';

describe('Result schema builder', () => {
  const schema = Result(z.object({ messageId: z.string() }));

  it('accepts success values', () => {
    expect(schema.parse({ ok: true, messageId: 'm1' })).toEqual({ ok: true, messageId: 'm1' });
  });

  it('accepts failures with a known reason', () => {
    const failure = { ok: false, reason: 'unsupported', message: 'nope' };
    expect(schema.parse(failure)).toEqual(failure);
  });

  it('rejects unknown failure reasons', () => {
    expect(schema.safeParse({ ok: false, reason: 'whatever', message: 'x' }).success).toBe(false);
  });

  it('rejects success values missing fields', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('ok / fail helpers', () => {
  it('builds success values', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ messageId: 'm1' })).toEqual({ ok: true, messageId: 'm1' });
  });

  it('builds failures', () => {
    expect(fail('forbidden', 'no')).toEqual({ ok: false, reason: 'forbidden', message: 'no' });
  });
});
