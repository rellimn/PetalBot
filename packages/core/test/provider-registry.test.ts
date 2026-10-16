import { fail, defineFailure, Result } from '@petalbot/sdk';
import { late, resultContract, timestamp } from './result-fixture.ts';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  AccessError,
  ProviderTimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  defineContract,
} from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { EventBus } from '../src/event-bus.ts';
import { ProviderRegistry } from '../src/provider-registry.ts';
import { counterContract, createMemoryLogger, delay } from './helpers.ts';

const SLOT = 'counter.sink';
const slotDef = counterContract.providers.sink;
const write = (input: { text: string }) => Promise.resolve({ id: `id-${input.text}` });

describe('ProviderRegistry', () => {
  it('exposes registered providers with their implemented methods', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    const view = registry.view(SLOT);
    expect(view.keys()).toEqual(['twitch:roman']);
    const handle = view.get('twitch:roman');
    expect(handle?.pluginId).toBe('twitch');
    expect(handle?.methods).toEqual(['write']);
    expect(handle?.has('write')).toBe(true);
    expect(handle?.has('flush')).toBe(false);
    await expect(handle?.call('write', { text: 'hi' })).resolves.toEqual({ id: 'id-hi' });
    expect(view.get('youtube:roman')).toBeUndefined();
  });

  it('throws UnsupportedCapabilityError for methods that are not implemented', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    await expect(registry.view(SLOT).get('twitch:roman')?.call('flush', {})).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it('validates provider input and output', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      methods: {
        write: () => Promise.resolve({ wrong: true }),
      },
    });
    const handle = registry.view(SLOT).get('twitch:roman');
    await expect(handle?.call('write', { text: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(handle?.call('write', { text: 'x' })).rejects.toThrow(
      /Invalid output of "twitch:roman" for "counter.sink.write"/,
    );
  });

  it('rejects unknown methods and duplicate keys', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
        methods: {
          shout: () => Promise.resolve({}),
        },
      }),
    ).toThrow(AccessError);
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    expect(() =>
      registry.register('kick', SLOT, slotDef, 'twitch:roman', { methods: { write } }),
    ).toThrow(/already registered by "twitch"/);
  });

  it('detects and binds methods of class-based providers', async () => {
    class Sink {
      readonly prefix = 'cls';
      write(input: { text: string }): Promise<{ id: string }> {
        return Promise.resolve({ id: `${this.prefix}-${input.text}` });
      }
    }
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: new Sink() });
    const handle = registry.view(SLOT).get('twitch:roman');
    expect(handle?.methods).toEqual(['write']);
    expect(handle?.has('write')).toBe(true);
    await expect(handle?.call('write', { text: 'hi' })).resolves.toEqual({ id: 'cls-hi' });
  });

  it('calls object-literal methods with their object as this', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      methods: {
        prefix: 'lit',
        write(this: { prefix: string }, input: { text: string }) {
          return Promise.resolve({ id: `${this.prefix}-${input.text}` });
        },
      },
    });
    await expect(
      registry.view(SLOT).get('twitch:roman')?.call('write', { text: 'hi' }),
    ).resolves.toEqual({ id: 'lit-hi' });
  });

  it('removes providers when disposed', () => {
    const registry = new ProviderRegistry();
    const provided = registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      methods: { write },
    });
    provided.dispose();
    expect(registry.view(SLOT).keys()).toEqual([]);
  });

  it("validates against the slot owner's running contract, not the one seen at registration", async () => {
    const contracts = new ContractRegistry();
    const unregister = contracts.register(counterContract);
    const registry = new ProviderRegistry({ contracts });
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    unregister();
    contracts.register(
      defineContract({
        ...counterContract,
        providers: {
          sink: {
            methods: {
              ...counterContract.providers.sink.methods,
              write: {
                input: z.object({ text: z.string().min(3) }),
                output: z.object({ id: z.string() }),
              },
            },
          },
        },
      }),
    );
    const handle = registry.view(SLOT).get('twitch:roman');
    await expect(handle?.call('write', { text: 'hi' })).rejects.toBeInstanceOf(ValidationError);
    await expect(handle?.call('write', { text: 'hello' })).resolves.toEqual({ id: 'id-hello' });
  });
});

describe('ProviderRegistry change listeners', () => {
  it('reports added and removed providers of the slot, once each', () => {
    const registry = new ProviderRegistry();
    const changes: unknown[] = [];
    registry.view(SLOT).onChange((change) => changes.push(change));
    registry.view('other.slot').onChange(() => changes.push('wrong slot'));
    const provided = registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      methods: { write },
    });
    provided.dispose();
    provided.dispose();
    expect(changes).toEqual([
      { key: 'twitch:roman', pluginId: 'twitch', change: 'added' },
      { key: 'twitch:roman', pluginId: 'twitch', change: 'removed' },
    ]);
  });

  it('stops calling a listener after its disposer ran', () => {
    const registry = new ProviderRegistry();
    const changes: string[] = [];
    const listener = (change: { change: string }) => changes.push(change.change);
    const first = registry.view(SLOT).onChange(listener);
    registry.view(SLOT).onChange(listener);
    first();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    expect(changes).toEqual(['added']);
  });

  it('reports nothing for a refused registration', () => {
    const registry = new ProviderRegistry();
    const changes: string[] = [];
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { methods: { write } });
    registry.view(SLOT).onChange((change) => changes.push(change.change));
    expect(() =>
      registry.register('kick', SLOT, slotDef, 'twitch:roman', { methods: { write } }),
    ).toThrow(AccessError);
    expect(changes).toEqual([]);
  });
});

describe('provider Result boundaries', () => {
  it('decodes failures using the running owner contract, including after replacement', async () => {
    const contracts = new ContractRegistry();
    const unregister = contracts.register(resultContract);
    const registry = new ProviderRegistry({ contracts });
    registry.register('source', 'clock.source', resultContract.providers.source, 'one', {
      methods: {
        read: () => Promise.resolve(fail(late, { at: timestamp })),
      },
    });
    const handle = registry.view('clock.source').get('one');
    await expect(handle?.call('read', {})).resolves.toEqual({
      ok: false,
      reason: 'custom',
      error: { code: 'late', at: new Date(timestamp) },
    });
    unregister();
    const gone = defineFailure({ code: 'gone', reason: 'not-found', details: z.object({}) });
    contracts.register(
      defineContract({
        ...resultContract,
        providers: {
          source: {
            methods: { read: { input: z.object({}), output: Result(z.object({}), [gone]) } },
          },
        },
      }),
    );
    await expect(handle?.call('read', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    { ok: false, reason: 'custom', error: { code: 'private', at: timestamp } },
    { ok: false, reason: 'not-found', error: { code: 'late', at: timestamp } },
    { ok: false, reason: 'custom', error: { code: 'late', at: 'invalid' } },
  ])('rejects an invalid provider failure: %j', async (value) => {
    const registry = new ProviderRegistry();
    registry.register('source', 'clock.source', resultContract.providers.source, 'one', {
      methods: {
        read: () => Promise.resolve(value),
      },
    });
    await expect(registry.view('clock.source').get('one')?.call('read', {})).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('times out provider calls after the method timeout or the default', async () => {
    vi.useFakeTimers();
    try {
      const slow = {
        methods: {
          send: { input: z.object({}), output: z.object({}), timeoutMs: 12_000 },
          ping: { input: z.object({}), output: z.object({}) },
        },
      };
      const registry = new ProviderRegistry();
      const never = () => new Promise<never>(() => undefined);
      registry.register('twitch', 'chat.platform', slow, 'twitch:roman', {
        methods: {
          send: never,
          ping: never,
        },
      });
      const handle = registry.view('chat.platform').get('twitch:roman');
      const send = handle?.call('send', {});
      const sendFailed = expect(send).rejects.toBeInstanceOf(ProviderTimeoutError);
      await vi.advanceTimersByTimeAsync(11_999);
      await vi.advanceTimersByTimeAsync(1);
      await sendFailed;
      const ping = handle?.call('ping', {});
      const pingFailed = expect(ping).rejects.toThrow('within 5000 ms');
      await vi.advanceTimersByTimeAsync(5_000);
      await pingFailed;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ProviderRegistry info and inbound', () => {
  const chatSlot = {
    key: z.string().regex(/^[a-z]+:.+$/),
    info: z.object({ channel: z.string() }),
    methods: {
      send: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
    },
    inbound: { message: z.object({ text: z.string().min(1) }) },
  };
  const setup = () => {
    const contracts = new ContractRegistry();
    const bus = new EventBus({ contracts, logger: createMemoryLogger() });
    const registry = new ProviderRegistry({ contracts, bus });
    return { bus, registry, view: registry.view('chat.platform') };
  };

  it('validates key and info when a provider registers', () => {
    const { registry } = setup();
    expect(() =>
      registry.register('twitch', 'chat.platform', chatSlot, 'roman', { info: { channel: 'r' } }),
    ).toThrow(ValidationError);
    expect(() =>
      registry.register('twitch', 'chat.platform', chatSlot, 'twitch:roman', {}),
    ).toThrow(ValidationError);
    expect(() =>
      registry.register('twitch', 'counter.sink', slotDef, 'twitch:roman', {
        info: { channel: 'r' },
      }),
    ).toThrow(AccessError);
  });

  it('delivers pushes in order to every owner handler with the info at push time', async () => {
    const { bus, registry, view } = setup();
    const seen: unknown[] = [];
    view.on('chat', 'message', (payload, provider) => {
      seen.push([payload, provider.info]);
    });
    const provided = registry.register('twitch', 'chat.platform', chatSlot, 'twitch:roman', {
      info: { channel: 'a' },
    });
    provided.push('message', { text: '1' });
    provided.update({ channel: 'b' });
    provided.push('message', { text: '2' });
    await bus.idle();
    expect(seen).toEqual([
      [{ text: '1' }, { channel: 'a' }],
      [{ text: '2' }, { channel: 'b' }],
    ]);
    expect(view.get('twitch:roman')?.info).toEqual({ channel: 'b' });
    expect(view.list().map((handle) => handle.key)).toEqual(['twitch:roman']);
  });

  it('rejects a malformed push at the pusher and delivers nothing', async () => {
    const { bus, registry, view } = setup();
    const handler = vi.fn();
    view.on('chat', 'message', handler);
    const provided = registry.register('twitch', 'chat.platform', chatSlot, 'twitch:roman', {
      info: { channel: 'a' },
    });
    expect(() => {
      provided.push('message', { text: '' });
    }).toThrow(ValidationError);
    expect(() => {
      provided.push('nope', {});
    }).toThrow(AccessError);
    await bus.idle();
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports updated and ignores push and update after dispose', async () => {
    const { bus, registry, view } = setup();
    const changes: string[] = [];
    const handler = vi.fn();
    view.onChange((change) => changes.push(change.change));
    view.on('chat', 'message', handler);
    const provided = registry.register('twitch', 'chat.platform', chatSlot, 'twitch:roman', {
      info: { channel: 'a' },
    });
    provided.update({ channel: 'b' });
    provided.dispose();
    provided.push('message', { text: 'late' });
    provided.update({ channel: 'c' });
    await bus.idle();
    expect(changes).toEqual(['added', 'updated', 'removed']);
    expect(view.list()).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops a push nobody handles', async () => {
    const { bus, registry } = setup();
    const provided = registry.register('twitch', 'chat.platform', chatSlot, 'twitch:roman', {
      info: { channel: 'a' },
    });
    provided.push('message', { text: 'x' });
    await expect(bus.idle()).resolves.toBeUndefined();
  });
});

describe('ProviderRegistry inbound order', () => {
  it('keeps one FIFO per owner across inbound names', async () => {
    const contracts = new ContractRegistry();
    const bus = new EventBus({ contracts, logger: createMemoryLogger() });
    const registry = new ProviderRegistry({ contracts, bus });
    const slot = {
      inbound: { message: z.object({ id: z.string() }), deleted: z.object({ id: z.string() }) },
    };
    const view = registry.view('chat.platform');
    const seen: string[] = [];
    view.on('chat', 'message', async (payload) => {
      await delay(5);
      seen.push(`message ${JSON.stringify(payload)}`);
    });
    view.on('chat', 'deleted', (payload) => {
      seen.push(`deleted ${JSON.stringify(payload)}`);
    });
    const provided = registry.register('twitch', 'chat.platform', slot, 'twitch:roman', {});
    provided.push('message', { id: '1' });
    provided.push('deleted', { id: '1' });
    await bus.idle();
    expect(seen).toEqual(['message {"id":"1"}', 'deleted {"id":"1"}']);
  });
});
