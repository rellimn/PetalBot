import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin } from '@petalbot/sdk';
import { createTestHarness } from '../src/harness.ts';

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
