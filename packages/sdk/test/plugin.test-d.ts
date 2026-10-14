import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '../src/contract.ts';
import { definePlugin, type RpcMeta } from '../src/plugin.ts';
import { Result, fail, ok } from '../src/result.ts';
import { bareContract } from './fixtures.ts';

const Counter = z.object({ id: z.string(), value: z.number().int() });
const counter = defineContract({
  id: 'counter',
  version: '1.0.0',
  settings: z.object({ step: z.number().int().default(1) }),
  rpc: {
    list: { output: z.array(Counter) },
    increment: {
      input: z.object({ counter: z.string() }),
      output: Result(z.object({ counter: Counter })),
    },
  },
});

describe('setup returns the RPC implementations', () => {
  it('types inputs, call info and settings from the contract', () => {
    definePlugin(counter, {
      setup(ctx) {
        expectTypeOf(ctx.settings.get()).toEqualTypeOf<{ step: number }>();
        return {
          rpc: {
            list: (input, call) => {
              expectTypeOf(input).toEqualTypeOf<undefined>();
              expectTypeOf(call).toEqualTypeOf<RpcMeta>();
              return [];
            },
            increment: ({ counter: id }, { who }) => {
              expectTypeOf(who).toEqualTypeOf<string>();
              return id === '' ? fail('not-found', 'no') : ok({ counter: { id, value: 1 } });
            },
          },
        };
      },
    });
  });

  it('accepts an async setup', () => {
    definePlugin(counter, {
      async setup() {
        await Promise.resolve();
        return {
          rpc: { list: () => [], increment: () => ok({ counter: { id: 'a', value: 1 } }) },
        };
      },
    });
  });

  it('requires every RPC of the contract', () => {
    definePlugin(counter, {
      // @ts-expect-error -- increment is missing
      setup: () => ({ rpc: { list: () => [] } }),
    });
  });

  it('checks outputs', () => {
    definePlugin(counter, {
      setup: () => ({
        rpc: {
          list: () => [],
          // @ts-expect-error -- not a Result
          increment: () => ({ ok: true }),
        },
      }),
    });
  });

  it('needs no return value for contracts without RPCs', () => {
    definePlugin(bareContract, {
      setup() {
        // nothing to set up
      },
    });
    definePlugin(bareContract, {
      async setup() {
        await Promise.resolve();
      },
    });
  });

  it('no longer accepts settings or rpc next to setup', () => {
    definePlugin(bareContract, {
      // @ts-expect-error -- settings live in the contract now
      settings: z.object({}),
      setup() {
        // nothing to set up
      },
    });
  });
});

describe('ctx.call', () => {
  it('takes no input for RPCs without input', () => {
    definePlugin(bareContract, {
      dependencies: [counter],
      async setup(ctx) {
        expectTypeOf(await ctx.call('counter.list')).toEqualTypeOf<
          { id: string; value: number }[]
        >();
        await ctx.call('counter.list', undefined, { timeoutMs: 100 });
        await ctx.call('counter.increment', { counter: 'a' });
        // @ts-expect-error -- input required
        await ctx.call('counter.increment');
        // @ts-expect-error -- takes no input
        await ctx.call('counter.list', { x: 1 });
      },
    });
  });
});

describe('ctx.kv.update and ctx.lock', () => {
  it('types the updater from the key and returns the stored value', () => {
    definePlugin(bareContract, {
      kv: { total: z.number().int() },
      async setup(ctx) {
        const total = await ctx.kv.update('total', (current) => {
          expectTypeOf(current).toEqualTypeOf<number | undefined>();
          return (current ?? 0) + 1;
        });
        expectTypeOf(total).toEqualTypeOf<number | undefined>();
        // @ts-expect-error -- the updater must be synchronous
        await ctx.kv.update('total', async (current) => (current ?? 0) + 1); // eslint-disable-line @typescript-eslint/require-await -- the intended error
        // @ts-expect-error -- unknown key
        await ctx.kv.update('nope', () => undefined);
        const value = await ctx.lock('total', () => Promise.resolve('done' as const));
        expectTypeOf(value).toEqualTypeOf<'done'>();
      },
    });
  });
});

describe('db', () => {
  it('takes migrations relative to the plugin folder', () => {
    const notes = sqliteTable('bare_notes', { id: integer('id') });
    definePlugin(bareContract, {
      db: { schema: { notes }, migrations: 'drizzle' },
      setup(ctx) {
        expectTypeOf(ctx.db.select().from(notes).all()).toEqualTypeOf<{ id: number | null }[]>();
      },
    });
    definePlugin(bareContract, {
      // @ts-expect-error -- the absolute migrationsFolder is gone
      db: { schema: { notes }, migrationsFolder: '/abs' },
      setup() {
        // nothing to set up
      },
    });
  });
});
