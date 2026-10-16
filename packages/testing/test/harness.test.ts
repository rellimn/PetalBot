import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Result, defineFailure, defineContract, definePlugin, fail, ok } from '@petalbot/sdk';
import { createTestHarness } from '../src';

const pointsContract = defineContract({
  id: 'points',
  version: '1.0.0',
  events: { changed: { schema: z.object({ userId: z.string(), balance: z.number() }) } },
  rpc: { getBalance: { input: z.object({ userId: z.string() }), output: z.number() } },
});

const rewardsContract = defineContract({
  id: 'rewards',
  version: '1.0.0',
  settings: z.object({ threshold: z.number().default(100) }),
  events: { granted: { schema: z.object({ userId: z.string() }) } },
  rpc: {
    check: { input: z.object({ userId: z.string() }), output: z.boolean() },
    threshold: { output: z.number() },
  },
});

const rewards = definePlugin(rewardsContract, {
  dependencies: [pointsContract],
  setup(ctx) {
    ctx.on('points.changed', (event) => {
      if (event.payload.balance >= ctx.settings.get().threshold) {
        ctx.emit('rewards.granted', { userId: event.payload.userId });
      }
    });
    return {
      rpc: {
        check: async ({ userId }) =>
          (await ctx.call('points.getBalance', { userId })) >= ctx.settings.get().threshold,
        threshold: () => ctx.settings.get().threshold,
      },
    };
  },
});

describe('createTestHarness', () => {
  it('calls own RPCs with faked dependency RPCs', async () => {
    const harness = await createTestHarness(rewards, {
      fakes: { points: { rpc: { getBalance: () => 150 } } },
    });
    await expect(harness.call('rewards.check', { userId: 'u' })).resolves.toBe(true);
    await harness.stop();
  });

  it('emits dependency events and records the resulting events', async () => {
    const harness = await createTestHarness(rewards);
    harness.emit('points.changed', { userId: 'u', balance: 120 });
    await harness.idle();
    expect(harness.events.map((e) => [e.name, e.payload])).toEqual([
      ['points.changed', { userId: 'u', balance: 120 }],
      ['rewards.granted', { userId: 'u' }],
    ]);
    await harness.stop();
  });

  it('starts with the given settings', async () => {
    const harness = await createTestHarness(rewards, { settings: { threshold: 200 } });
    harness.emit('points.changed', { userId: 'u', balance: 150 });
    await harness.idle();
    expect(harness.events.map((e) => e.name)).toEqual(['points.changed']);
    await harness.stop();
  });

  it('fails loudly for RPCs that are not faked', async () => {
    const harness = await createTestHarness(rewards);
    await expect(harness.call('rewards.check', { userId: 'u' })).rejects.toThrow(
      'RPC "points.getBalance" is not faked in this harness',
    );
    await harness.stop();
  });

  it('types settings from the contract and calls RPCs without input', async () => {
    const harness = await createTestHarness(rewards, { settings: { threshold: 7 } });
    await expect(harness.call('rewards.threshold')).resolves.toBe(7);
    // @ts-expect-error -- threshold is a number
    void createTestHarness(rewards, { settings: { threshold: 'high' } }).catch(() => undefined);
    await harness.stop();
  });

  it('updates settings like the panel does', async () => {
    const harness = await createTestHarness(rewards);
    await expect(harness.updateSettings({ threshold: 3 })).resolves.toEqual({ threshold: 3 });
    await expect(harness.call('rewards.threshold')).resolves.toBe(3);
    await harness.stop();
  });

  it('needs the plugin folder for plugins with a db when none can be found', async () => {
    const notes = sqliteTable('notes_items', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      text: text('text').notNull(),
    });
    const notesPlugin = definePlugin(defineContract({ id: 'notes', version: '1.0.0' }), {
      db: { schema: { notes }, migrations: 'migrations' },
      setup() {
        // nothing to set up
      },
    });
    // packages/testing has no petalbot package.json above its tests, so discovery finds nothing.
    await expect(createTestHarness(notesPlugin)).rejects.toThrow(
      'createTestHarness: plugin "notes" declares db; pass { dir } with its folder',
    );
    const dir = join(import.meta.dirname, '../../core/test/fixtures/notes-db');
    const harness = await createTestHarness(notesPlugin, { dir });
    expect(harness.kernel.isRunning('notes')).toBe(true);
    await harness.stop();
  });

  it('only accepts dependency events and own RPCs (compile-time)', () => {
    const check = (
      harness: Awaited<
        ReturnType<typeof createTestHarness<typeof rewardsContract, [typeof pointsContract], []>>
      >,
    ) => {
      // @ts-expect-error -- own events are emitted by the plugin, not the test
      harness.emit('rewards.granted', { userId: 'u' });
      // @ts-expect-error -- dependency RPCs are faked, not called
      void harness.call('points.getBalance', { userId: 'u' });
    };
    expect(check).toBeTypeOf('function');
  });
});

const vaultContract = defineContract({
  id: 'vault',
  version: '1.0.0',
  secrets: {
    apiKey: { userSettable: true, label: 'API key' },
    tokens: { schema: z.object({ accessToken: z.string() }), keyed: true },
  },
  rpc: {
    read: {
      kind: 'query',
      output: z.object({ apiKey: z.string().nullable(), tokens: z.array(z.string()) }),
    },
    changes: { kind: 'query', output: z.array(z.string()) },
    callback: { kind: 'query', output: z.string() },
  },
});

const vault = definePlugin(vaultContract, {
  setup(ctx) {
    const changes: string[] = [];
    ctx.secrets.onChange('apiKey', () => {
      changes.push('apiKey');
    });
    ctx.secrets.onChange('tokens', (key) => {
      changes.push(`tokens:${key}`);
    });
    return {
      rpc: {
        read: async () => ({
          apiKey: (await ctx.secrets.get('apiKey')) ?? null,
          tokens: await ctx.secrets.keys('tokens'),
        }),
        changes: () => changes,
        callback: () => ctx.http.url('/auth/callback'),
      },
    };
  },
});

describe('createTestHarness secrets and URLs', () => {
  it('seeds secrets and fires onChange on setSecret', async () => {
    const harness = await createTestHarness(vault, {
      secrets: { apiKey: 'k-1', tokens: { u1: { accessToken: 'a' } } },
    });
    expect(await harness.call('vault.read')).toEqual({ apiKey: 'k-1', tokens: ['u1'] });
    await harness.setSecret('apiKey', 'k-2');
    await harness.setSecret('tokens', 'u2', { accessToken: 'b' });
    expect(await harness.call('vault.read')).toEqual({ apiKey: 'k-2', tokens: ['u1', 'u2'] });
    expect(await harness.call('vault.changes')).toEqual(['apiKey', 'tokens:u2']);
    await harness.stop();
  });

  it('trims user-settable values and deletes on empty, as the panel does', async () => {
    const harness = await createTestHarness(vault, { secrets: { apiKey: 'k-1' } });
    await harness.setSecret('apiKey', '  k-3\n');
    expect(await harness.call('vault.read')).toEqual({ apiKey: 'k-3', tokens: [] });
    await harness.setSecret('apiKey', ' ');
    expect(await harness.call('vault.read')).toEqual({ apiKey: null, tokens: [] });
    await harness.stop();
  });

  it('uses the given public URL for ctx.http.url', async () => {
    const harness = await createTestHarness(vault, { publicUrl: 'https://bot.test' });
    expect(await harness.call('vault.callback')).toBe('https://bot.test/api/p/vault/auth/callback');
    await harness.stop();
  });
});

const providerNotFound = defineFailure({
  code: 'provider-not-found',
  reason: 'not-found',
  details: z.object({ key: z.string() }),
});

const sinkContract = defineContract({
  id: 'sink',
  version: '1.0.0',
  providers: {
    target: {
      info: z.object({ label: z.string() }),
      methods: {
        write: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
      inbound: { written: z.object({ text: z.string() }) },
    },
  },
  rpc: {
    keys: { kind: 'query', output: z.array(z.string()) },
    keysAtStart: { kind: 'query', output: z.array(z.string()) },
    labels: { kind: 'query', output: z.array(z.string()) },
    received: { kind: 'query', output: z.array(z.string()) },
    write: {
      input: z.object({ key: z.string(), text: z.string() }),
      output: Result(z.object({ id: z.string() }), [providerNotFound]),
    },
  },
});

const sink = definePlugin(sinkContract, {
  setup(ctx) {
    const atStart = ctx.providers('sink.target').keys();
    const received: string[] = [];
    ctx.providers('sink.target').on('written', ({ text }, provider) => {
      received.push(`${provider.key}:${text}`);
    });
    return {
      rpc: {
        labels: () =>
          ctx
            .providers('sink.target')
            .list()
            .map((provider) => provider.info.label),
        received: () => received,
        keys: () => ctx.providers('sink.target').keys(),
        keysAtStart: () => atStart,
        write: async ({ key, text }) => {
          const provider = ctx.providers('sink.target').get(key);
          if (!provider) return fail(providerNotFound, { key }, `No ${key}`);
          return ok(await provider.call('write', { text }));
        },
      },
    };
  },
});

describe('createTestHarness provider fakes', () => {
  it('registers fake providers before the slot owner starts', async () => {
    const harness = await createTestHarness(sink, {
      providers: {
        'sink.target': {
          'fake:a': {
            info: { label: 'A' },
            methods: { write: ({ text }) => Promise.resolve({ id: `a-${text}` }) },
          },
        },
      },
    });
    expect(await harness.call('sink.keysAtStart')).toEqual(['fake:a']);
    expect(await harness.call('sink.write', { key: 'fake:a', text: 'hi' })).toEqual({
      ok: true,
      id: 'a-hi',
    });
    await harness.stop();
  });

  it('adds providers mid-test, pushes through them and removes them', async () => {
    const harness = await createTestHarness(sink);
    const provided = harness.addProvider('sink.target', 'fake:b', {
      info: { label: 'B' },
      methods: { write: () => Promise.resolve({ id: 'b' }) },
    });
    expect(await harness.call('sink.keys')).toEqual(['fake:b']);
    expect(await harness.call('sink.labels')).toEqual(['B']);
    provided.push('written', { text: 'hi' });
    await harness.idle();
    expect(await harness.call('sink.received')).toEqual(['fake:b:hi']);
    provided.dispose();
    expect(await harness.call('sink.keys')).toEqual([]);
    await harness.stop();
  });

  it("returns the handle an implementer's slot owner would see", async () => {
    const writer = definePlugin(defineContract({ id: 'writer', version: '1.0.0' }), {
      dependencies: [sinkContract],
      setup(ctx) {
        const provided = ctx.provide('sink.target', 'writer:main', {
          info: { label: 'Writer' },
          methods: { write: ({ text }) => Promise.resolve({ id: text.toUpperCase() }) },
        });
        provided.push('written', { text: 'hello' });
        provided.push('written', { text: 'again' });
      },
    });
    const harness = await createTestHarness(writer);
    await harness.idle();
    expect(harness.pushed('sink.target', 'writer:main')).toEqual([
      { name: 'written', payload: { text: 'hello' } },
      { name: 'written', payload: { text: 'again' } },
    ]);
    expect(harness.pushed('sink.target', 'nope')).toEqual([]);
    const handle = harness.provider('sink.target', 'writer:main');
    expect(handle?.pluginId).toBe('writer');
    expect(handle?.info).toEqual({ label: 'Writer' });
    expect(handle?.methods).toEqual(['write']);
    expect(await handle?.call('write', { text: 'hi' })).toEqual({ id: 'HI' });
    expect(harness.provider('sink.target', 'nope')).toBeUndefined();
    await harness.stop();
  });
});
