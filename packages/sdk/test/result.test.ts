import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { codecs } from '../src/codecs.ts';
import { Result, defineFailure, fail, failuresIn, ok } from '../src/result.ts';

const group = defineFailure({
  code: 'group-not-found',
  reason: 'not-found',
  details: z.object({ groupId: z.string() }),
});
const entity = defineFailure({
  code: 'entity-not-found',
  reason: 'not-found',
  details: z.object({ groupId: z.string(), entityId: z.string() }),
});
const queue = defineFailure({
  code: 'queue-full',
  reason: 'custom',
  details: z.object({ capacity: z.number().int() }),
});

describe('Result schema builder', () => {
  const schema = Result(z.object({ messageId: z.string() }), [group, entity]);

  it('accepts success values', () => {
    expect(schema.parse({ ok: true, messageId: 'm1' })).toEqual({ ok: true, messageId: 'm1' });
  });

  it('accepts failures with a known reason', () => {
    const failure = {
      ok: false,
      reason: 'not-found',
      error: { code: 'group-not-found', groupId: 'g' },
    };
    expect(schema.parse(failure)).toEqual(failure);
  });

  it('rejects unknown failure reasons', () => {
    expect(schema.safeParse({ ok: false, reason: 'whatever', message: 'x' }).success).toBe(false);
  });

  it('rejects success values missing fields', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false);
  });

  it('rejects undeclared codes, wrong categories and invalid details', () => {
    expect(schema.safeParse(fail(queue, { capacity: 1 })).success).toBe(false);
    expect(schema.safeParse({ ...fail(group, { groupId: 'g' }), reason: 'custom' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ok: false, reason: 'not-found' }).success).toBe(false);
    expect(
      schema.safeParse({
        ok: false,
        reason: 'not-found',
        error: { code: 'entity-not-found', groupId: 'g' },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...fail(group, { groupId: 'g' }), message: 12 }).success).toBe(false);
  });

  it('preserves details and optional diagnostics', () => {
    expect(schema.parse(fail(entity, { groupId: 'g', entityId: 'e' }))).toEqual({
      ok: false,
      reason: 'not-found',
      error: { code: 'entity-not-found', groupId: 'g', entityId: 'e' },
    });
    expect(fail(group, { groupId: 'g' }, undefined)).not.toHaveProperty('message');
    expect(schema.parse(fail(group, { groupId: 'g' }, 'diagnostic'))).toHaveProperty(
      'message',
      'diagnostic',
    );
  });

  it('supports zero or one explicitly selected failure', () => {
    const none = Result(z.object({}), []);
    expect(none.parse(ok())).toEqual({ ok: true });
    expect(none.safeParse(fail(group, { groupId: 'g' })).success).toBe(false);
    expect(Result(z.object({}), [group]).parse(fail(group, { groupId: 'g' }))).toHaveProperty(
      'error.groupId',
      'g',
    );
  });

  it('rejects duplicate codes even with distinct definitions', () => {
    expect(() => Result(z.object({}), [group, group])).toThrow(/Duplicate/);
    const duplicate = defineFailure({
      code: 'group-not-found',
      reason: 'custom',
      details: z.object({}),
    });
    expect(() => Result(z.object({}), [group, duplicate])).toThrow(/Duplicate/);
  });

  it('rejects empty codes and reserved schema keys at runtime', () => {
    expect(() => defineFailure({ code: '', reason: 'custom', details: z.object({}) })).toThrow(
      TypeError,
    );
    expect(() =>
      defineFailure({
        code: 'x',
        reason: 'custom',
        // @ts-expect-error -- exercise the runtime guard too
        details: z.object({ code: z.string() }),
      }),
    ).toThrow(TypeError);
    // @ts-expect-error -- exercise the runtime guard too
    expect(() => Result(z.object({ ok: z.string() }), [])).toThrow(TypeError);
  });

  it('preserves refinements and strictness when adding reserved fields', () => {
    const range = z.object({ low: z.number(), high: z.number() }).refine((v) => v.low <= v.high);
    const invalid = defineFailure({ code: 'invalid-range', reason: 'custom', details: range });
    expect(invalid.schema.safeParse(fail(invalid, { low: 2, high: 1 })).success).toBe(false);
    expect(invalid.schema.safeParse(fail(invalid, { low: 1, high: 2 })).success).toBe(true);
    const success = Result(range, []);
    expect(success.safeParse({ ok: true, low: 2, high: 1 }).success).toBe(false);
    expect(success.safeParse({ ok: true, low: 1, high: 2 }).success).toBe(true);
    const strict = defineFailure({
      code: 'strict',
      reason: 'custom',
      details: z.strictObject({ id: z.string() }),
    });
    expect(strict.schema.safeParse(fail(strict, { id: 'x' })).success).toBe(true);
    expect(
      strict.schema.safeParse({
        ok: false,
        reason: 'custom',
        error: { code: 'strict', id: 'x', extra: true },
      }).success,
    ).toBe(false);
  });

  it('round-trips codec details without pre-decoding in the constructor', () => {
    const late = defineFailure({
      code: 'late',
      reason: 'custom',
      details: z.object({ at: codecs.isoDate() }),
    });
    const timed = Result(z.object({}), [late]);
    const input = fail(late, { at: '2026-10-16T10:00:00.000Z' });
    const decoded = timed.parse(input);
    expect(decoded).toEqual({
      ok: false,
      reason: 'custom',
      error: { code: 'late', at: new Date('2026-10-16T10:00:00.000Z') },
    });
    expect(z.encode(timed, decoded)).toEqual(input);
    expect(z.decode(timed, z.encode(timed, decoded))).toEqual(decoded);
  });
});

describe('ok / fail helpers', () => {
  it('builds success values', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ messageId: 'm1' })).toEqual({ ok: true, messageId: 'm1' });
  });

  it('builds failures', () => {
    expect(fail(queue, { capacity: 2 }, 'no')).toEqual({
      ok: false,
      reason: 'custom',
      error: { code: 'queue-full', capacity: 2 },
      message: 'no',
    });
  });
});

describe('failuresIn', () => {
  it('finds failure definitions anywhere inside a schema', () => {
    const schema = z.object({
      items: z.record(z.string(), Result(z.object({}), [group]).nullable()),
      last: Result(z.object({}), [entity, group]).optional(),
    });
    expect(failuresIn(schema)).toEqual(new Set([group, entity]));
    expect(failuresIn(z.object({ ok: z.boolean() }))).toEqual(new Set());
  });
});
