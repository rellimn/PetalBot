import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '../src/contract.ts';
import { definePlugin } from '../src/plugin.ts';
import type { ProviderImpl } from '../src/index.ts';
import { codecs } from '../src/codecs.ts';
import { Result, defineFailure, fail, type Failure } from '../src/result.ts';

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
  details: z.object({ capacity: z.number() }),
});
const schema = Result(z.object({ value: z.number() }), [group, entity]);
type Failed = Extract<z.output<typeof schema>, Failure>;

function describeFailure(failure: Failed): string {
  const error = failure.error;
  switch (error.code) {
    case 'group-not-found':
      return error.groupId;
    case 'entity-not-found':
      return error.entityId;
  }
  error satisfies never;
  return 'unreachable';
}

describe('exact Result types', () => {
  it('accepts a plain code-only envelope for empty details', () => {
    const emptyFailure = defineFailure({
      code: 'denied',
      reason: 'forbidden',
      details: z.object({}),
    });
    expectTypeOf(emptyFailure).not.toBeNever();
    const value: z.input<typeof emptyFailure.schema> = {
      ok: false,
      reason: 'forbidden',
      error: { code: 'denied' },
    };
    expectTypeOf(value.error).toEqualTypeOf<{ code: 'denied' }>();
  });
  it('infers exact literals and narrows each payload', () => {
    expectTypeOf(schema).not.toBeNever();
    expectTypeOf<Failed['reason']>().toEqualTypeOf<'not-found'>();
    expectTypeOf<Failed['error']['code']>().toEqualTypeOf<'group-not-found' | 'entity-not-found'>();
    expectTypeOf(describeFailure).returns.toEqualTypeOf<string>();
    const broad: Failure = fail(group, { groupId: 'g' });
    expectTypeOf(broad).toExtend<Failure>();
    const empty = Result(z.object({}), []);
    const success: z.input<typeof empty> = { ok: true };
    expectTypeOf(success).toEqualTypeOf<{ ok: true }>();
    expectTypeOf(empty).not.toBeNever();
    expectTypeOf<Extract<z.output<typeof empty>, Failure>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Result<{ value: number }>, Failure>>().toEqualTypeOf<never>();
  });

  it('rejects undeclared variants, missing details and reserved fields', () => {
    // @ts-expect-error -- capacity is required
    fail(queue, {});
    // @ts-expect-error -- entityId is required
    fail(entity, { groupId: 'g' });
    // @ts-expect-error -- a producer cannot invent a variant
    const wrong: z.input<typeof schema> = fail(queue, { capacity: 1 });
    expectTypeOf(wrong).not.toBeNever();
    // @ts-expect-error -- code is reserved in constructor details
    fail(group, { groupId: 'g', code: 'another' });
    // @ts-expect-error -- a failure list is always explicit
    Result(z.object({}));
    // @ts-expect-error -- ok is reserved in success schemas
    Result(z.object({ ok: z.boolean() }), []);
    // @ts-expect-error -- code is reserved in detail schemas
    defineFailure({ code: 'x', reason: 'custom', details: z.object({ code: z.string() }) });
  });

  it('makes a handler incomplete only when its operation changes', () => {
    const expanded = Result(z.object({}), [group, entity, queue]);
    expectTypeOf(expanded).not.toBeNever();
    function incomplete(failure: Extract<z.output<typeof expanded>, Failure>) {
      const error = failure.error;
      if (error.code === 'group-not-found' || error.code === 'entity-not-found') return;
      // @ts-expect-error -- queue-full still needs handling
      error satisfies never;
    }
    expectTypeOf(incomplete).toBeFunction();
    expectTypeOf<Failed['error']['code']>().toEqualTypeOf<'group-not-found' | 'entity-not-found'>();
  });

  it('keeps codec input and output distinct', () => {
    const late = defineFailure({
      code: 'late',
      reason: 'custom',
      details: z.object({ at: codecs.isoDate() }),
    });
    expectTypeOf<z.input<typeof late.schema>['error']['at']>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof late.schema>['error']['at']>().toEqualTypeOf<Date>();
    const failure = fail(late, { at: '2026-10-16T10:00:00.000Z' });
    expectTypeOf(failure.error.at).toEqualTypeOf<string>();
    // @ts-expect-error -- producers supply the schema input
    fail(late, { at: new Date() });
  });
});

const late = defineFailure({
  code: 'late',
  reason: 'custom',
  details: z.object({ at: codecs.isoDate() }),
});
const clock = defineContract({
  id: 'clock',
  version: '1.0.0',
  rpc: { read: { output: Result(z.object({}), [late]) } },
  providers: { source: { read: { input: z.object({}), output: Result(z.object({}), [late]) } } },
});

it('preserves exact producer and consumer types through real contracts', () => {
  definePlugin(clock, {
    setup: () => ({ rpc: { read: () => fail(late, { at: '2026-10-16T10:00:00.000Z' }) } }),
  });
  definePlugin(clock, {
    setup: () => ({
      rpc: {
        // @ts-expect-error -- this RPC does not declare queue-full
        read: () => fail(queue, { capacity: 1 }),
      },
    }),
  });
  const provider: ProviderImpl<typeof clock.providers.source> = {
    read: () => Promise.resolve(fail(late, { at: '2026-10-16T10:00:00.000Z' })),
  };
  expectTypeOf(provider).not.toBeNever();
  const invalid: ProviderImpl<typeof clock.providers.source> = {
    // @ts-expect-error -- provider must use a declared variant
    read: () => Promise.resolve(fail(queue, { capacity: 1 })),
  };
  expectTypeOf(invalid).not.toBeNever();
  definePlugin(defineContract({ id: 'consumer', version: '1.0.0' }), {
    dependencies: [clock],
    async setup(ctx) {
      const result = await ctx.call('clock.read');
      if (!result.ok) {
        expectTypeOf(result.error.code).toEqualTypeOf<'late'>();
        expectTypeOf(result.error.at).toEqualTypeOf<Date>();
      }
    },
  });
  definePlugin(clock, {
    async setup(ctx) {
      const providerResult = await ctx.providers('clock.source').get('one')?.call('read', {});
      if (providerResult?.ok === false) expectTypeOf(providerResult.error.at).toEqualTypeOf<Date>();
      return { rpc: { read: () => ({ ok: true as const }) } };
    },
  });
});

it('requires a narrowed definition before constructing its correlated payload', () => {
  const selected = Math.random() > 0.5 ? group : queue;
  // @ts-expect-error -- a union definition cannot drop the required payload fields
  fail(selected, {});
  // @ts-expect-error -- a union definition cannot accept a payload for only one alternative
  fail(selected, { groupId: 'g' });
  // @ts-expect-error -- even both payloads do not establish a correlated definition
  fail(selected, { groupId: 'g', capacity: 1 });
  if (selected.code === 'group-not-found') {
    expectTypeOf(fail(selected, { groupId: 'g' }).error.code).toEqualTypeOf<'group-not-found'>();
  }
});

it('preserves required never fields in nonempty schemas', () => {
  const impossible = Result(z.object({ value: z.never() }), []);
  expectTypeOf(impossible).not.toBeNever();
  // @ts-expect-error -- the required value field makes this success impossible
  const success: z.input<typeof impossible> = { ok: true };
  expectTypeOf(success).not.toBeNever();
  const impossibleFailure = defineFailure({
    code: 'impossible',
    reason: 'custom',
    details: z.object({ value: z.never() }),
  });
  // @ts-expect-error -- an impossible required field is not an empty detail schema
  fail(impossibleFailure, {});
  // @ts-expect-error -- the generic type preserves required never fields too
  const generic: Result<{ value: never }> = { ok: true };
  expectTypeOf(generic).not.toBeNever();
});

describe('failure codes per contract', () => {
  it('rejects two different failures with one code', () => {
    const missing = defineFailure({ code: 'missing', reason: 'not-found', details: z.object({}) });
    const alsoMissing = defineFailure({
      code: 'missing',
      reason: 'custom',
      details: z.object({ id: z.string() }),
    });
    defineContract({
      id: 'reuse',
      version: '1.0.0',
      rpc: {
        get: { output: Result(z.object({}), [missing]) },
        remove: { output: Result(z.object({}), [missing]) },
      },
    });
    // @ts-expect-error -- "missing" names two different failures
    defineContract({
      id: 'clash',
      version: '1.0.0',
      rpc: {
        get: { output: Result(z.object({}), [missing]) },
        remove: { output: Result(z.object({}), [alsoMissing]) },
      },
    });
  });
});
