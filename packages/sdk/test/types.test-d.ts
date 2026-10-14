import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { ProviderHandle } from '../src/context.ts';
import type { EventEnvelope } from '../src/envelope.ts';
import { definePlugin } from '../src/plugin.ts';
import type { FailureReason } from '../src/result.ts';
import type { Disposer } from '../src/type-utils.ts';
import { bareContract, chatContract, pointsContract, quotesContract } from './fixtures.ts';

describe('ctx.on', () => {
  it('accepts own and dependency events with typed payloads', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
      rpc: { list: () => [] },
      setup(ctx) {
        ctx.on('quotes.added', (event) => {
          expectTypeOf(event).toEqualTypeOf<
            EventEnvelope<'quotes.added', { id: string; text: string }>
          >();
        });
        ctx.on('chat.message', (event) => {
          expectTypeOf(event.payload).toEqualTypeOf<{ text: string; user: string }>();
        });
        ctx.on('points.changed', (event) => {
          expectTypeOf(event.payload.balance).toEqualTypeOf<number>();
        });
      },
    });
  });

  it('rejects events of contracts that are not dependencies', () => {
    definePlugin(quotesContract, {
      rpc: { list: () => [] },
      setup(ctx) {
        // @ts-expect-error -- chat is not a dependency
        ctx.on('chat.message', () => undefined);
        // @ts-expect-error -- unknown event
        ctx.on('quotes.removed', () => undefined);
      },
    });
  });
});

describe('ctx.emit', () => {
  it('accepts own events only', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      rpc: { list: () => [] },
      setup(ctx) {
        ctx.emit('quotes.added', { id: '1', text: 'hi' });
        // @ts-expect-error -- cannot emit a dependency's event
        ctx.emit('chat.message', { text: 'x', user: 'y' });
        // @ts-expect-error -- payload is checked
        ctx.emit('quotes.added', { id: 1, text: 'hi' });
      },
    });
  });
});

describe('ctx.call', () => {
  it('infers input and output of dependency RPCs', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
      rpc: { list: () => [] },
      async setup(ctx) {
        const balance = await ctx.call('points.getBalance', { userId: 'u' });
        expectTypeOf(balance).toEqualTypeOf<number>();
        const sent = await ctx.call('chat.send', { text: 'hi' }, { timeoutMs: 100 });
        expectTypeOf(sent).toEqualTypeOf<
          { ok: true; messageId: string } | { ok: false; reason: FailureReason; message: string }
        >();
      },
    });
  });

  it('rejects own and unknown RPCs', () => {
    definePlugin(quotesContract, {
      rpc: { list: () => [] },
      async setup(ctx) {
        // @ts-expect-error -- own RPCs are implemented, not called
        await ctx.call('quotes.list', {});
        // @ts-expect-error -- points is not a dependency
        await ctx.call('points.getBalance', { userId: 'u' });
      },
    });
  });

  it('forces Result narrowing before reading success fields', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      rpc: { list: () => [] },
      async setup(ctx) {
        const sent = await ctx.call('chat.send', { text: 'hi' });
        // @ts-expect-error -- messageId only exists after checking ok
        expectTypeOf(sent.messageId).toBeString();
        if (sent.ok) expectTypeOf(sent.messageId).toEqualTypeOf<string>();
        else
          expectTypeOf(sent.reason).toEqualTypeOf<
            'unsupported' | 'forbidden' | 'not-found' | 'rate-limited' | 'platform-error'
          >();
      },
    });
  });
});

describe('hooks', () => {
  it('runs own hooks and taps dependency hooks', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      rpc: { list: () => [] },
      async setup(ctx) {
        const result = await ctx.runHook('quotes.beforeAdd', { text: 'x' });
        if (!result.vetoed) expectTypeOf(result.value).toEqualTypeOf<{ text: string }>();
        ctx.hook('chat.beforeSend', (input, { veto }) => {
          expectTypeOf(input).toEqualTypeOf<{ text: string }>();
          return input.text === '' ? veto('empty') : { text: input.text.trim() };
        });
        // @ts-expect-error -- only the owner runs a hook
        await ctx.runHook('chat.beforeSend', { text: 'x' });
      },
    });
  });
});

describe('providers', () => {
  it('lets dependents implement a subset of a slot', () => {
    definePlugin(bareContract, {
      dependencies: [chatContract],
      setup(ctx) {
        ctx.provide('chat.platform', 'twitch:roman', {
          send: ({ text }) => Promise.resolve({ messageId: text }),
        });
        ctx.provide('chat.platform', 'twitch:roman', {
          // @ts-expect-error -- unknown method
          shout: () => Promise.resolve({}),
        });
      },
    });
  });

  it('gives the owner typed handles', () => {
    definePlugin(chatContract, {
      rpc: { send: () => ({ ok: false, reason: 'unsupported', message: 'x' }) },
      async setup(ctx) {
        const handle = ctx.providers('chat.platform').get('twitch:roman');
        expectTypeOf(handle).toEqualTypeOf<
          ProviderHandle<(typeof chatContract)['providers']['platform']> | undefined
        >();
        if (handle) {
          const out = await handle.call('send', { text: 'hi' });
          expectTypeOf(out).toEqualTypeOf<{ messageId: string }>();
        }
      },
    });
  });
});

describe('definePlugin rpc implementations', () => {
  it('requires every own RPC to be implemented', () => {
    // @ts-expect-error -- rpc.list is missing
    definePlugin(quotesContract, {
      setup() {
        // nothing to set up
      },
    });
  });

  it('checks implementation return types', () => {
    definePlugin(quotesContract, {
      // @ts-expect-error -- wrong return type
      rpc: { list: () => 'nope' },
      setup() {
        // nothing to set up
      },
    });
  });

  it('keeps literal return types in zero-argument implementations', () => {
    definePlugin(chatContract, {
      // eslint-disable-next-line @typescript-eslint/require-await -- async on purpose: tests literal inference
      rpc: { send: async () => ({ ok: false, reason: 'unsupported', message: 'x' }) },
      setup() {
        // nothing to set up
      },
    });
  });

  it('types RPC implementation parameters', () => {
    definePlugin(chatContract, {
      rpc: {
        send: (input, meta) => {
          expectTypeOf(input).toEqualTypeOf<{ text: string }>();
          expectTypeOf(meta.caller).toEqualTypeOf<string>();
          return { ok: true, messageId: input.text };
        },
      },
      setup() {
        // nothing to set up
      },
    });
  });

  it('forbids rpc on contracts without RPCs', () => {
    definePlugin(bareContract, {
      // @ts-expect-error -- bare has no rpc
      rpc: {},
      setup() {
        // nothing to set up
      },
    });
  });
});
const quoteRows = sqliteTable('quotes_rows', {
  id: integer('id').primaryKey(),
  text: text('text').notNull(),
});

describe('storage and scheduling', () => {
  it('types settings, kv, secrets and schedule', () => {
    definePlugin(quotesContract, {
      settings: z.object({
        prefix: z.string().default('!'),
        cooldownMs: z.number().int().default(3000),
      }),
      kv: { counter: z.number().int(), lastUser: z.string() },
      rpc: { list: () => [] },
      async setup(ctx) {
        expectTypeOf(ctx.settings.get()).toEqualTypeOf<{ prefix: string; cooldownMs: number }>();
        expectTypeOf(await ctx.kv.get('counter')).toEqualTypeOf<number | undefined>();
        await ctx.kv.set('lastUser', 'someone');
        // @ts-expect-error -- wrong value type
        await ctx.kv.set('counter', 'x');
        // @ts-expect-error -- undeclared key
        await ctx.kv.get('nope');
        expectTypeOf(await ctx.secrets.get('token')).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx.schedule.every(1000, () => undefined)).toEqualTypeOf<Disposer>();
        ctx.settings.onChange((next, previous) => {
          expectTypeOf(next.prefix).toEqualTypeOf<string>();
          expectTypeOf(previous.cooldownMs).toEqualTypeOf<number>();
        });
      },
    });
  });

  it('defaults to empty settings and no kv keys', () => {
    definePlugin(quotesContract, {
      rpc: { list: () => [] },
      async setup(ctx) {
        expectTypeOf(ctx.settings.get()).toEqualTypeOf<Record<string, never>>();
        // @ts-expect-error -- no kv declared
        await ctx.kv.get('counter');
      },
    });
  });

  it('restricts isRunning to dependencies', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
      rpc: { list: () => [] },
      setup(ctx) {
        expectTypeOf(ctx.isRunning('points')).toEqualTypeOf<boolean>();
        ctx.isRunning('chat');
        // @ts-expect-error -- not a dependency
        ctx.isRunning('other');
      },
    });
  });

  it('types ctx.db from the declared schema', () => {
    definePlugin(quotesContract, {
      db: { schema: { quoteRows }, migrationsFolder: '/unused' },
      rpc: { list: () => [] },
      setup(ctx) {
        const rows = ctx.db.select().from(quoteRows).all();
        expectTypeOf(rows).toEqualTypeOf<{ id: number; text: string }[]>();
      },
    });
  });

  it('makes ctx.db unusable without a db declaration', () => {
    definePlugin(quotesContract, {
      rpc: { list: () => [] },
      setup(ctx) {
        // @ts-expect-error -- no db declared
        ctx.db.select(); // eslint-disable-line @typescript-eslint/no-unsafe-call -- must not compile
      },
    });
  });
});

describe('RPC implementations', () => {
  it('receive the typed ctx in meta', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      kv: { count: z.number() },
      rpc: {
        list: async (_input, { caller, ctx }) => {
          expectTypeOf(caller).toEqualTypeOf<string>();
          expectTypeOf(await ctx.kv.get('count')).toEqualTypeOf<number | undefined>();
          await ctx.call('chat.send', { text: 'hi' });
          return [];
        },
      },
      setup() {
        // nothing to set up
      },
    });
  });
});
