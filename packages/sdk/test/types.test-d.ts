import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { ProviderChange, ProviderHandle } from '../src/context.ts';
import type { EventEnvelope } from '../src/envelope.ts';
import { defineContract } from '../src/contract.ts';
import { definePlugin } from '../src/plugin.ts';
import type { Actor, Disposer, Via } from '../src/index.ts';
import { bareContract, chatContract, pointsContract, quotesContract } from './fixtures.ts';

describe('ctx.on', () => {
  it('accepts own and dependency events with typed payloads', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
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
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('rejects events of contracts that are not dependencies', () => {
    definePlugin(quotesContract, {
      setup(ctx) {
        // @ts-expect-error -- chat is not a dependency
        ctx.on('chat.message', () => undefined);
        // @ts-expect-error -- unknown event
        ctx.on('quotes.removed', () => undefined);
        return { rpc: { list: () => [] } };
      },
    });
  });
});

describe('ctx.emit', () => {
  it('accepts own events only', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      setup(ctx) {
        ctx.emit('quotes.added', { id: '1', text: 'hi' });
        // @ts-expect-error -- cannot emit a dependency's event
        ctx.emit('chat.message', { text: 'x', user: 'y' });
        // @ts-expect-error -- payload is checked
        ctx.emit('quotes.added', { id: 1, text: 'hi' });
        return { rpc: { list: () => [] } };
      },
    });
  });
});

describe('ctx.call', () => {
  it('infers input and output of dependency RPCs', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
      async setup(ctx) {
        const balance = await ctx.call('points.getBalance', { userId: 'u' });
        expectTypeOf(balance).toEqualTypeOf<number>();
        const sent = await ctx.call('chat.send', { text: 'hi' }, { timeoutMs: 100 });
        expectTypeOf(sent).toExtend<
          | { ok: true; messageId: string }
          | {
              ok: false;
              reason: 'forbidden';
              error: { code: 'send-denied' };
              message?: string | undefined;
            }
        >();
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('rejects own and unknown RPCs', () => {
    definePlugin(quotesContract, {
      async setup(ctx) {
        // @ts-expect-error -- own RPCs are implemented, not called
        await ctx.call('quotes.list', {});
        // @ts-expect-error -- points is not a dependency
        await ctx.call('points.getBalance', { userId: 'u' });
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('forces Result narrowing before reading success fields', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      async setup(ctx) {
        const sent = await ctx.call('chat.send', { text: 'hi' });
        // @ts-expect-error -- messageId only exists after checking ok
        expectTypeOf(sent.messageId).toBeString();
        if (sent.ok) expectTypeOf(sent.messageId).toEqualTypeOf<string>();
        else expectTypeOf(sent.reason).toEqualTypeOf<'forbidden'>();
        return { rpc: { list: () => [] } };
      },
    });
  });
});

describe('hooks', () => {
  it('runs own hooks and taps dependency hooks', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      async setup(ctx) {
        const result = await ctx.runHook('quotes.beforeAdd', { text: 'x' });
        if (!result.vetoed) expectTypeOf(result.value).toEqualTypeOf<{ text: string }>();
        ctx.hook('chat.beforeSend', (input, { veto }) => {
          expectTypeOf(input).toEqualTypeOf<{ text: string }>();
          return input.text === '' ? veto('empty') : { text: input.text.trim() };
        });
        // @ts-expect-error -- only the owner runs a hook
        await ctx.runHook('chat.beforeSend', { text: 'x' });
        return { rpc: { list: () => [] } };
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
      async setup(ctx) {
        const handle = ctx.providers('chat.platform').get('twitch:roman');
        expectTypeOf(handle).toEqualTypeOf<
          ProviderHandle<(typeof chatContract)['providers']['platform']> | undefined
        >();
        if (handle) {
          const out = await handle.call('send', { text: 'hi' });
          expectTypeOf(out).toEqualTypeOf<{ messageId: string }>();
        }
        return {
          rpc: {
            send: () => ({
              ok: false,
              reason: 'forbidden',
              error: { code: 'send-denied' },
              message: 'x',
            }),
          },
        };
      },
    });
  });

  it('tells the owner which provider came or went', () => {
    definePlugin(chatContract, {
      setup(ctx) {
        const stop = ctx.providers('chat.platform').onChange((change) => {
          expectTypeOf(change).toEqualTypeOf<ProviderChange>();
          expectTypeOf(change.change).toEqualTypeOf<'added' | 'removed'>();
        });
        expectTypeOf(stop).toEqualTypeOf<Disposer>();
        return {
          rpc: {
            send: () => ({
              ok: false,
              reason: 'forbidden',
              error: { code: 'send-denied' },
              message: 'x',
            }),
          },
        };
      },
    });
  });
});

describe('definePlugin rpc implementations', () => {
  it('requires every own RPC to be implemented', () => {
    definePlugin(quotesContract, {
      // @ts-expect-error -- rpc.list is missing
      setup() {
        // nothing to set up
      },
    });
  });

  it('checks implementation return types', () => {
    definePlugin(quotesContract, {
      // @ts-expect-error -- wrong return type
      setup: () => ({ rpc: { list: () => 'nope' } }),
    });
  });

  it('keeps literal return types in zero-argument implementations', () => {
    definePlugin(chatContract, {
      setup: () => ({
        rpc: {
          // eslint-disable-next-line @typescript-eslint/require-await -- async on purpose: tests literal inference
          send: async () => ({
            ok: false,
            reason: 'forbidden',
            error: { code: 'send-denied' },
            message: 'x',
          }),
        },
      }),
    });
  });

  it('types RPC implementation parameters', () => {
    definePlugin(chatContract, {
      setup: () => ({
        rpc: {
          send: (input, meta) => {
            expectTypeOf(input).toEqualTypeOf<{ text: string }>();
            expectTypeOf(meta.caller).toEqualTypeOf<string>();
            expectTypeOf(meta.who).toEqualTypeOf<string>();
            expectTypeOf(meta.actor).toEqualTypeOf<Actor>();
            expectTypeOf(meta.via).toEqualTypeOf<Via | undefined>();
            return { ok: true, messageId: input.text };
          },
        },
      }),
    });
  });

  it('forbids rpc on contracts without RPCs', () => {
    definePlugin(bareContract, {
      // @ts-expect-error -- bare has no rpc
      setup: () => ({ rpc: { list: () => [] } }),
    });
  });
});
const quoteRows = sqliteTable('quotes_rows', {
  id: integer('id').primaryKey(),
  text: text('text').notNull(),
});

describe('storage and scheduling', () => {
  it('types settings, kv, secrets and schedule', () => {
    const withSettings = defineContract({
      ...quotesContract,
      settings: z.object({
        prefix: z.string().default('!'),
        cooldownMs: z.number().int().default(3000),
      }),
      secrets: { token: {} },
    });
    definePlugin(withSettings, {
      kv: { counter: z.number().int(), lastUser: z.string() },
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
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('defaults to empty settings and no kv keys', () => {
    definePlugin(quotesContract, {
      async setup(ctx) {
        expectTypeOf(ctx.settings.get()).toEqualTypeOf<Record<string, never>>();
        // @ts-expect-error -- no kv declared
        await ctx.kv.get('counter');
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('restricts isRunning to dependencies', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      optionalDependencies: [pointsContract],
      setup(ctx) {
        expectTypeOf(ctx.isRunning('points')).toEqualTypeOf<boolean>();
        ctx.isRunning('chat');
        // @ts-expect-error -- not a dependency
        ctx.isRunning('other');
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('types ctx.db from the declared schema', () => {
    definePlugin(quotesContract, {
      db: { schema: { quoteRows }, migrations: 'drizzle' },
      setup(ctx) {
        const rows = ctx.db.select().from(quoteRows).all();
        expectTypeOf(rows).toEqualTypeOf<{ id: number; text: string }[]>();
        return { rpc: { list: () => [] } };
      },
    });
  });

  it('makes ctx.db unusable without a db declaration', () => {
    definePlugin(quotesContract, {
      setup(ctx) {
        // @ts-expect-error -- no db declared
        ctx.db.select(); // eslint-disable-line @typescript-eslint/no-unsafe-call -- must not compile
        return { rpc: { list: () => [] } };
      },
    });
  });
});

describe('RPC implementations', () => {
  it('reach the typed ctx through the setup closure', () => {
    definePlugin(quotesContract, {
      dependencies: [chatContract],
      kv: { count: z.number() },
      setup(ctx) {
        return {
          rpc: {
            list: async (_input, { caller }) => {
              expectTypeOf(caller).toEqualTypeOf<string>();
              expectTypeOf(await ctx.kv.get('count')).toEqualTypeOf<number | undefined>();
              await ctx.call('chat.send', { text: 'hi' });
              return [];
            },
          },
        };
      },
    });
  });
});

describe('flow marks', () => {
  it('are accepted on events and RPCs and keep their literal label', () => {
    const contract = defineContract({
      id: 'marks',
      version: '1.0.0',
      events: {
        raid: { schema: z.object({ from: z.string() }), flow: { label: 'Raid', filter: ['from'] } },
      },
      rpc: { give: { output: z.object({}), flow: { label: 'Give', retryable: true } } },
    });
    expectTypeOf(contract.events.raid.flow.label).toEqualTypeOf<'Raid'>();
    expectTypeOf(contract.rpc.give.flow.retryable).toEqualTypeOf<true>();
  });

  it('need a string label', () => {
    defineContract({
      id: 'marks',
      version: '1.0.0',
      // @ts-expect-error a label is text
      rpc: { give: { output: z.object({}), flow: { label: 1 } } },
    });
  });
});
