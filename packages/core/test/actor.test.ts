import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  defineContract,
  definePlugin,
  type EventEnvelope,
  type PanelUser,
  type RpcMeta,
} from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { createMemoryLogger, delay } from './helpers.ts';

const mia: PanelUser = { id: 'mia-id', name: 'mia', role: 'mod' };

const leafContract = defineContract({
  id: 'leaf',
  version: '1.0.0',
  rpc: { whoami: { output: z.object({}) } },
});
const middleContract = defineContract({
  id: 'middle',
  version: '1.0.0',
  events: { announced: { schema: z.object({}) } },
  rpc: {
    forward: { output: z.object({}) },
    announce: { output: z.object({}) },
  },
});

type Seen = Pick<RpcMeta, 'caller' | 'who' | 'actor'>;

/** leaf records who called; middle forwards and announces; listener reacts to announcements. */
async function start(options: { emitOnSetup?: boolean } = {}) {
  const kernel = new Kernel({ logger: createMemoryLogger() });
  const envelopes: EventEnvelope[] = [];
  kernel.tap((envelope) => envelopes.push(envelope));
  const seen: Seen[] = [];
  await kernel.start(
    definePlugin(leafContract, {
      setup: () => ({
        rpc: {
          whoami: (_input, { caller, who, actor }) => {
            seen.push({ caller, who, actor });
            return {};
          },
        },
      }),
    }),
  );
  await kernel.start(
    definePlugin(middleContract, {
      dependencies: [leafContract],
      setup(ctx) {
        // Later, from a timer: outside any call, after the listener has subscribed.
        if (options.emitOnSetup === true) {
          ctx.schedule.after(1, () => {
            ctx.emit('middle.announced', {});
          });
        }
        return {
          rpc: {
            forward: async () => {
              await ctx.call('leaf.whoami');
              return {};
            },
            announce: () => {
              ctx.emit('middle.announced', {});
              return {};
            },
          },
        };
      },
    }),
  );
  await kernel.start(
    definePlugin(defineContract({ id: 'listener', version: '1.0.0' }), {
      dependencies: [middleContract, leafContract],
      setup(ctx) {
        ctx.on('middle.announced', async () => {
          await ctx.call('leaf.whoami');
        });
      },
    }),
  );
  return { kernel, envelopes, seen };
}

describe('the actor', () => {
  it('gives a plain plugin call the calling plugin as actor', async () => {
    const { kernel, seen } = await start();
    await kernel.start(
      definePlugin(defineContract({ id: 'caller', version: '1.0.0' }), {
        dependencies: [leafContract],
        async setup(ctx) {
          await ctx.call('leaf.whoami');
        },
      }),
    );
    expect(seen).toEqual([
      { caller: 'caller', who: 'caller', actor: { kind: 'plugin', pluginId: 'caller' } },
    ]);
  });

  it('keeps a panel user as actor through a nested call', async () => {
    const { kernel, seen } = await start();
    await kernel.callFromClient('middle.forward', undefined, { kind: 'panel', user: mia });
    expect(seen).toEqual([{ caller: 'middle', who: 'mia', actor: { kind: 'user', user: mia } }]);
  });

  it('gives an overlay call the overlay instance as actor', async () => {
    const { kernel, seen } = await start();
    await kernel.callFromClient('middle.forward', undefined, { kind: 'overlay', instanceId: 'i1' });
    expect(seen[0]?.actor).toEqual({ kind: 'overlay', instanceId: 'i1' });
    expect(seen[0]?.who).toBe('overlay');
  });

  it('carries the actor of an RPC onto events it emits and into their handlers', async () => {
    const { kernel, envelopes, seen } = await start();
    await kernel.callFromClient('middle.announce', undefined, { kind: 'panel', user: mia });
    await kernel.idle();
    expect(envelopes.find((envelope) => envelope.name === 'middle.announced')?.actor).toEqual({
      kind: 'user',
      user: mia,
    });
    expect(seen).toEqual([{ caller: 'listener', who: 'mia', actor: { kind: 'user', user: mia } }]);
  });

  it('emits without an actor outside any call', async () => {
    const { kernel, envelopes, seen } = await start({ emitOnSetup: true });
    await delay(20);
    await kernel.idle();
    expect(envelopes[0]).not.toHaveProperty('actor');
    expect(seen[0]?.actor).toEqual({ kind: 'plugin', pluginId: 'listener' });
  });
});
