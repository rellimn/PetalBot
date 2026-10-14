import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { currentPlugin, runInPlugin } from '../src/plugin-scope.ts';
import { createUncaughtHandler } from '../src/process-guards.ts';
import { counterContract, createMemoryLogger, delay, listenerContract } from './helpers.ts';

describe('plugin attribution', () => {
  it('runs plugin code attributed to the plugin that owns it', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const seen: Record<string, string | undefined> = {};
    const api: { tick?: () => Promise<void>; write?: () => Promise<unknown> } = {};
    await kernel.start(
      definePlugin(counterContract, {
        setup(ctx) {
          seen.setup = currentPlugin();
          api.tick = async () => {
            const result = await ctx.runHook('counter.beforeTick', { n: 1 });
            if (!result.vetoed) ctx.emit('counter.ticked', result.value);
          };
          api.write = () =>
            ctx.providers('counter.sink').get('listener:main')?.call('write', { text: 'x' }) ??
            Promise.resolve(undefined);
          return {
            rpc: {
              double: ({ n }) => {
                seen.rpc = currentPlugin();
                return n * 2;
              },
            },
          };
        },
      }),
    );
    await kernel.start(
      definePlugin(listenerContract, {
        dependencies: [counterContract],
        async setup(ctx) {
          ctx.on('counter.ticked', () => {
            seen.handler = currentPlugin();
          });
          ctx.hook('counter.beforeTick', () => {
            seen.hook = currentPlugin();
            return undefined;
          });
          ctx.provide('counter.sink', 'listener:main', {
            write: () => {
              seen.provider = currentPlugin();
              return Promise.resolve({ id: 'x' });
            },
          });
          await ctx.call('counter.double', { n: 1 });
        },
      }),
    );
    await api.tick?.();
    await api.write?.();
    await kernel.idle();
    expect(seen).toEqual({
      setup: 'counter',
      rpc: 'counter',
      hook: 'listener',
      handler: 'listener',
      provider: 'listener',
    });
    expect(currentPlugin()).toBeUndefined();
  });

  it('keeps the attribution across awaits', async () => {
    let attributed: string | undefined;
    runInPlugin('listener', () => {
      void (async () => {
        await delay(1);
        attributed = currentPlugin();
      })();
    });
    await delay(10);
    expect(attributed).toBe('listener');
  });

  it('marks a plugin degraded after repeated handler failures', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger(), health: { threshold: 3 } });
    const changes: [string, boolean][] = [];
    kernel.onHealthChange((id, degraded) => {
      changes.push([id, degraded]);
    });
    const tick: { run?: (n: number) => void } = {};
    await kernel.start(
      definePlugin(counterContract, {
        setup(ctx) {
          tick.run = (n) => {
            ctx.emit('counter.ticked', { n });
          };
          return { rpc: { double: ({ n }) => n * 2 } };
        },
      }),
    );
    await kernel.start(
      definePlugin(listenerContract, {
        dependencies: [counterContract],
        setup(ctx) {
          ctx.on('counter.ticked', () => {
            throw new Error('boom');
          });
        },
      }),
    );
    tick.run?.(1);
    tick.run?.(2);
    await kernel.idle();
    expect(kernel.isDegraded('listener')).toBe(false);
    tick.run?.(3);
    await kernel.idle();
    expect(kernel.isDegraded('listener')).toBe(true);
    expect(changes).toEqual([['listener', true]]);

    await kernel.stop('listener');
    await kernel.start(
      definePlugin(listenerContract, {
        dependencies: [counterContract],
        setup() {
          // healthy again
        },
      }),
    );
    expect(kernel.isDegraded('listener')).toBe(false);
  });

  it('attributes uncaught errors to the plugin in scope', () => {
    const logger = createMemoryLogger();
    const kernel = new Kernel({ logger });
    expect(runInPlugin('listener', () => kernel.reportUncaught(new Error('late')))).toBe(true);
    expect(kernel.isDegraded('listener')).toBe(true);
    expect(kernel.reportUncaught(new Error('core'))).toBe(false);
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Uncaught error in plugin',
      data: { plugin: 'listener', error: 'late' },
    });
  });

  it('keeps running on plugin errors and exits on core errors', () => {
    const exit = vi.fn<(code: number) => void>();
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const handler = createUncaughtHandler({ kernel, logger: createMemoryLogger(), exit });
    runInPlugin('listener', () => {
      handler(new Error('plugin bug'));
    });
    expect(exit).not.toHaveBeenCalled();
    handler(new Error('core bug'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
