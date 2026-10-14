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
  events: { granted: { schema: z.object({ userId: z.string() }) } },
  rpc: { check: { input: z.object({ userId: z.string() }), output: z.boolean() } },
});

const rewards = definePlugin(rewardsContract, {
  dependencies: [pointsContract],
  settings: z.object({ threshold: z.number().default(100) }),
  rpc: {
    check: async ({ userId }, { ctx }) =>
      (await ctx.call('points.getBalance', { userId })) >= ctx.settings.get().threshold,
  },
  setup(ctx) {
    ctx.on('points.changed', (event) => {
      if (event.payload.balance >= ctx.settings.get().threshold) {
        ctx.emit('rewards.granted', { userId: event.payload.userId });
      }
    });
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
