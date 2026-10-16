import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  PluginUnavailableError,
  ValidationError,
  defineContract,
  definePlugin,
  type EventEnvelope,
} from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { currentPlugin } from '../src/plugin-scope.ts';
import { counterContract, createMemoryLogger, delay, listenerContract } from './helpers.ts';

/** The listener's ctx type, as captured by a test that keeps it past stop(). */
type StaleContext = Parameters<
  ReturnType<typeof definePlugin<typeof listenerContract, [typeof counterContract], []>>['setup']
>[0];

interface CounterApi {
  tick(n: number): Promise<void>;
  sinkKeys(): string[];
  write(key: string, text: string): Promise<{ id: string } | undefined>;
}

function counterPlugin(onApi: (api: CounterApi) => void) {
  return definePlugin(counterContract, {
    setup(ctx) {
      onApi({
        async tick(n) {
          const result = await ctx.runHook('counter.beforeTick', { n });
          if (!result.vetoed) ctx.emit('counter.ticked', result.value);
        },
        sinkKeys: () => ctx.providers('counter.sink').keys(),
        write: (key, text) =>
          ctx.providers('counter.sink').get(key)?.call('write', { text }) ??
          Promise.resolve(undefined),
      });
      return { rpc: { double: ({ n }) => n * 2 } };
    },
  });
}

async function startCounter(kernel: Kernel): Promise<CounterApi> {
  const holder: { api?: CounterApi } = {};
  await kernel.start(
    counterPlugin((api) => {
      holder.api = api;
    }),
  );
  if (!holder.api) throw new Error('counter did not start');
  return holder.api;
}

function listenerPlugin(options: { heard: number[]; disposed?: string[] }) {
  return definePlugin(listenerContract, {
    dependencies: [counterContract],
    async setup(ctx) {
      ctx.on('counter.ticked', (event) => {
        options.heard.push(event.payload.n);
      });
      ctx.hook('counter.beforeTick', ({ n }, { veto }) =>
        n < 0 ? veto('negative') : { n: n + 1 },
      );
      ctx.provide('counter.sink', 'listener:main', {
        write: ({ text }) => Promise.resolve({ id: `id-${text}` }),
      });
      ctx.onDispose(() => {
        options.disposed?.push('first');
      });
      ctx.onDispose(() => {
        options.disposed?.push('second');
      });
      expect(await ctx.call('counter.double', { n: 4 })).toBe(8);
    },
  });
}

describe('Kernel', () => {
  it('wires events, hooks, RPC and providers between plugins', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const counter = await startCounter(kernel);
    const heard: number[] = [];
    await kernel.start(listenerPlugin({ heard }));
    await counter.tick(1);
    await counter.tick(-5);
    await kernel.idle();
    expect(heard).toEqual([2]);
    expect(counter.sinkKeys()).toEqual(['listener:main']);
    await expect(counter.write('listener:main', 'x')).resolves.toEqual({ id: 'id-x' });
  });

  it('disposes everything a plugin registered when it stops', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const counter = await startCounter(kernel);
    const heard: number[] = [];
    const disposed: string[] = [];
    await kernel.start(listenerPlugin({ heard, disposed }));
    await kernel.stop('listener');

    const tapped: unknown[] = [];
    kernel.tap((event: EventEnvelope) => {
      tapped.push(event.payload);
    });
    await counter.tick(1);
    await kernel.idle();

    expect(kernel.isRunning('listener')).toBe(false);
    expect(heard).toEqual([]);
    expect(tapped).toEqual([{ n: 1 }]);
    expect(counter.sinkKeys()).toEqual([]);
    expect(disposed).toEqual(['second', 'first']);
  });

  it('refuses to start a plugin whose required dependency is not running', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await expect(kernel.start(listenerPlugin({ heard: [] }))).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
  });

  it('refuses to start the same plugin twice', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await startCounter(kernel);
    await expect(startCounter(kernel)).rejects.toThrow(/already running/);
  });

  it('rolls back registrations when setup throws', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const counter = await startCounter(kernel);
    const leaked: number[] = [];
    const failing = definePlugin(listenerContract, {
      dependencies: [counterContract],
      setup(ctx) {
        ctx.provide('counter.sink', 'listener:main', {
          write: () => Promise.resolve({ id: 'x' }),
        });
        ctx.hook('counter.beforeTick', () => ({ n: 100 }));
        ctx.on('counter.ticked', (event) => {
          leaked.push(event.payload.n);
        });
        throw new Error('setup failed');
      },
    });
    await expect(kernel.start(failing)).rejects.toThrow('setup failed');
    expect(kernel.isRunning('listener')).toBe(false);
    expect(counter.sinkKeys()).toEqual([]);

    const heard: number[] = [];
    await kernel.start(listenerPlugin({ heard }));
    await counter.tick(1);
    await kernel.idle();
    expect(heard).toEqual([2]);
    expect(leaked).toEqual([]);
  });

  it('ignores registrations attempted after a failed setup', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const counter = await startCounter(kernel);
    let lateError: unknown;
    const failing = definePlugin(listenerContract, {
      dependencies: [counterContract],
      async setup(ctx) {
        await Promise.all([
          (async () => {
            await delay(5);
            throw new Error('early failure');
          })(),
          (async () => {
            await delay(20);
            try {
              ctx.provide('counter.sink', 'listener:main', {
                write: () => Promise.resolve({ id: 'late' }),
              });
            } catch (error) {
              lateError = error;
            }
          })(),
        ]);
      },
    });
    await expect(kernel.start(failing)).rejects.toThrow('early failure');
    await delay(40);
    expect(lateError).toBeInstanceOf(PluginUnavailableError);
    expect(counter.sinkKeys()).toEqual([]);
    await kernel.start(listenerPlugin({ heard: [] }));
    expect(counter.sinkKeys()).toEqual(['listener:main']);
  });

  it("rejects every use of a stopped plugin's ctx", async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await startCounter(kernel);
    const holder: { ctx?: StaleContext } = {};
    await kernel.start(
      definePlugin(listenerContract, {
        dependencies: [counterContract],
        setup(ctx) {
          holder.ctx = ctx;
        },
      }),
    );
    await kernel.stop('listener');
    const stale = holder.ctx;
    if (!stale) throw new Error('listener did not start');

    expect(() => {
      stale.emit('listener.heard', { n: 1 });
    }).toThrow(PluginUnavailableError);
    expect(() => stale.on('counter.ticked', () => undefined)).toThrow(PluginUnavailableError);
    expect(() =>
      stale.provide('counter.sink', 'listener:main', {
        write: () => Promise.resolve({ id: 'stale' }),
      }),
    ).toThrow(PluginUnavailableError);
    expect(() => {
      stale.onDispose(() => undefined);
    }).toThrow(PluginUnavailableError);
    await expect(stale.call('counter.double', { n: 1 })).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
    await kernel.start(listenerPlugin({ heard: [] }));
  });

  it('delivers optional-dependency events only while that dependency runs', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const heard: number[] = [];
    await kernel.start(
      definePlugin(listenerContract, {
        optionalDependencies: [counterContract],
        setup(ctx) {
          ctx.on('counter.ticked', (event) => {
            heard.push(event.payload.n);
          });
        },
      }),
    );
    const counter = await startCounter(kernel);
    await counter.tick(3);
    await kernel.idle();
    expect(heard).toEqual([3]);
  });

  it('enforces access rules at runtime', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await startCounter(kernel);
    const checks: Promise<void>[] = [];
    await kernel.start(
      definePlugin(listenerContract, {
        setup(ctx) {
          // Simulates untyped code (casts, plain JS plugins).
          const untyped = ctx as unknown as {
            emit(name: string, payload: unknown): void;
            on(name: string, handler: () => void): void;
            call(name: string, input: unknown): Promise<unknown>;
            providers(slot: string): unknown;
          };
          expect(() => {
            untyped.emit('counter.ticked', { n: 1 });
          }).toThrow(AccessError);
          expect(() => {
            untyped.on('counter.ticked', () => undefined);
          }).toThrow(AccessError);
          expect(() => untyped.providers('counter.sink')).toThrow(AccessError);
          checks.push(
            expect(untyped.call('counter.double', { n: 1 })).rejects.toBeInstanceOf(AccessError),
          );
        },
      }),
    );
    await Promise.all(checks);
  });

  it('passes the plugin ctx to RPC implementations', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await kernel.start(
      definePlugin(counterContract, {
        setup(ctx) {
          return {
            rpc: {
              double: ({ n }) => {
                ctx.emit('counter.ticked', { n });
                return n * 2;
              },
            },
          };
        },
      }),
    );
    const heard: number[] = [];
    await kernel.start(
      definePlugin(listenerContract, {
        dependencies: [counterContract],
        async setup(ctx) {
          ctx.on('counter.ticked', (event) => {
            heard.push(event.payload.n);
          });
          expect(await ctx.call('counter.double', { n: 21 })).toBe(42);
        },
      }),
    );
    await kernel.idle();
    expect(heard).toEqual([21]);
  });
});

describe('Kernel RPC registration', () => {
  const pingContract = defineContract({
    id: 'ping',
    version: '1.0.0',
    rpc: {
      ping: { output: z.string() },
      echo: { input: z.object({ text: z.string() }), output: z.string() },
    },
  });
  const panelCall = {
    kind: 'panel' as const,
    user: { id: 'u1', name: 'Mia', role: 'mod' as const },
  };

  it('registers the RPCs setup returns and tells them who called', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const seen: string[] = [];
    await kernel.start(
      definePlugin(pingContract, {
        setup: () => ({
          rpc: {
            ping: (_input, { who }) => {
              seen.push(who);
              return 'pong';
            },
            echo: ({ text }) => text,
          },
        }),
      }),
    );
    await expect(kernel.callFromClient('ping.ping', undefined, panelCall)).resolves.toBe('pong');
    await expect(
      kernel.callFromClient('ping.ping', undefined, { kind: 'overlay', instanceId: 'i1' }),
    ).resolves.toBe('pong');
    await expect(kernel.callFromClient('ping.echo', { text: 'hi' }, panelCall)).resolves.toBe('hi');
    expect(seen).toEqual(['Mia', 'overlay']);
  });

  it('rejects input for RPCs without input', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    await kernel.start(
      definePlugin(pingContract, {
        setup: () => ({ rpc: { ping: () => 'pong', echo: ({ text }) => text } }),
      }),
    );
    await expect(
      kernel.callFromClient('ping.ping', { text: 'x' }, panelCall),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('answers PluginUnavailableError while setup is still running, then serves the call', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = kernel.start(
      definePlugin(pingContract, {
        async setup() {
          await gate;
          return { rpc: { ping: () => 'pong', echo: ({ text }) => text } };
        },
      }),
    );
    await delay(5);
    await expect(kernel.callFromClient('ping.ping', undefined, panelCall)).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
    release();
    await starting;
    await expect(kernel.callFromClient('ping.ping', undefined, panelCall)).resolves.toBe('pong');
  });

  it('refuses a setup that misses an RPC or implements an unknown one', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const missing = { contract: pingContract, setup: () => ({ rpc: { ping: () => 'pong' } }) };
    await expect(kernel.start(missing)).rejects.toThrow(
      'Plugin "ping" does not implement RPC "echo" (setup must return { rpc: { echo: ... } })',
    );
    expect(kernel.isRunning('ping')).toBe(false);
    const extra = {
      contract: pingContract,
      setup: () => ({ rpc: { ping: () => 'pong', echo: () => '', other: () => '' } }),
    };
    await expect(kernel.start(extra)).rejects.toThrow(
      'Plugin "ping" implements "other", which is not an RPC of its contract',
    );
    await expect(kernel.callFromClient('ping.ping', undefined, panelCall)).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
  });
});

describe('Kernel provider changes', () => {
  function watcher(seen: string[], options: { throws?: boolean } = {}) {
    return definePlugin(counterContract, {
      setup(ctx) {
        ctx.providers('counter.sink').onChange(({ key, change }) => {
          seen.push(`${change} ${key} as ${currentPlugin() ?? 'nobody'}`);
          if (options.throws === true) throw new Error('listener broke');
        });
        return { rpc: { double: ({ n }) => n * 2 } };
      },
    });
  }

  it('tells the slot owner when a provider comes and when its plugin stops', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const seen: string[] = [];
    await kernel.start(watcher(seen));
    await kernel.start(listenerPlugin({ heard: [] }));
    await kernel.stop('listener');
    expect(seen).toEqual(['added listener:main as counter', 'removed listener:main as counter']);
  });

  it('removes the listener when the slot owner stops', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger() });
    const seen: string[] = [];
    await kernel.start(watcher(seen));
    await kernel.stop('counter');
    await kernel.start(counterPlugin(() => undefined));
    await kernel.start(listenerPlugin({ heard: [] }));
    expect(seen).toEqual([]);
  });

  it('logs a throwing listener and keeps the registration', async () => {
    const logger = createMemoryLogger();
    const kernel = new Kernel({ logger });
    const seen: string[] = [];
    await kernel.start(watcher(seen, { throws: true }));
    await kernel.start(listenerPlugin({ heard: [] }));
    expect(seen).toEqual(['added listener:main as counter']);
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Provider change listener failed',
      data: expect.objectContaining({ slot: 'counter.sink', error: 'listener broke' }) as object,
    });
  });
});
