import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin, type RpcClient } from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { currentPlugin } from '../src/plugin-scope.ts';
import { counterContract, createMemoryLogger } from './helpers.ts';

const webContract = defineContract({
  id: 'web',
  version: '1.0.0',
  events: { pinged: { schema: z.object({}), expose: ['panel'] } },
  rpc: {
    whoami: {
      input: z.object({}),
      output: z.object({ caller: z.string(), client: z.string().optional() }),
      expose: { panel: 'mod' },
    },
  },
});

function webPlugin(options: { fail?: boolean } = {}) {
  return definePlugin(webContract, {
    setup(ctx) {
      ctx.http.route('GET', '/ping', () => {
        if (options.fail === true) throw new Error('boom');
        return Response.json({ plugin: currentPlugin() });
      });
      return {
        rpc: {
          whoami: (_input, { caller, client }) => ({
            caller,
            ...(client ? { client: client.kind } : {}),
          }),
        },
      };
    },
  });
}

const ping = () => new Request('http://bot.test/api/p/web/ping');
const asMod = { user: { id: 'u', name: 'mia', role: 'mod' as const }, sameOrigin: true };

describe('Kernel HTTP routes', () => {
  it('serves ctx.http routes only while the plugin runs', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await kernel.start(webPlugin());
    const response = await kernel.routes.dispatch('web', ping(), asMod);
    await expect(response.json()).resolves.toEqual({ plugin: 'web' });
    await kernel.stop('web');
    expect(kernel.routes.has('web')).toBe(false);
  });

  it('counts failing routes toward the plugin health', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger(), health: { threshold: 2 } });
    await kernel.start(webPlugin({ fail: true }));
    for (let i = 0; i < 2; i++) {
      expect((await kernel.routes.dispatch('web', ping(), asMod)).status).toBe(500);
    }
    expect(kernel.isDegraded('web')).toBe(true);
  });
});

describe('Kernel client calls and lookups', () => {
  it('passes the browser client to RPC implementations', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await kernel.start(webPlugin());
    const client: RpcClient = { kind: 'overlay', instanceId: 'i1' };
    await expect(kernel.callFromClient('web.whoami', {}, client)).resolves.toEqual({
      caller: 'client',
      client: 'overlay',
    });
  });

  it('looks up contracts, events and RPCs of running plugins only', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await kernel.start(webPlugin());
    expect(kernel.contract('web')).toBe(webContract);
    expect(kernel.eventDef('web.pinged')?.owner).toBe('web');
    expect(kernel.rpcDef('web.whoami')?.def.expose).toEqual({ panel: 'mod' });
    await kernel.stop('web');
    expect(kernel.contract('web')).toBeUndefined();
    expect(kernel.eventDef('web.pinged')).toBeUndefined();
  });

  it('refuses overlays that use contracts the plugin does not depend on', async () => {
    const shelfContract = defineContract({
      id: 'shelf',
      version: '1.0.0',
      overlays: {
        box: { dependencies: [counterContract], config: z.object({}), events: [], rpc: [] },
      },
    });
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await expect(
      kernel.start(definePlugin(shelfContract, { setup: () => undefined })),
    ).rejects.toThrow(
      'Overlay "box" of plugin "shelf" uses "counter", which is not a dependency of the plugin',
    );
    expect(kernel.isRunning('shelf')).toBe(false);
  });
});
