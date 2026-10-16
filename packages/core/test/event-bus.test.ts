import { describe, expect, it, vi } from 'vitest';
import { AccessError, ValidationError, type EventEnvelope } from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { EventBus } from '../src/event-bus.ts';
import { currentPlugin, runInPlugin } from '../src/plugin-scope.ts';
import { counterContract, createMemoryLogger, delay, listenerContract } from './helpers.ts';

function setup(maxDepth?: number) {
  const contracts = new ContractRegistry();
  contracts.register(counterContract);
  contracts.register(listenerContract);
  const logger = createMemoryLogger();
  const bus = new EventBus({ contracts, logger, ...(maxDepth === undefined ? {} : { maxDepth }) });
  return { bus, logger };
}

const n = (event: EventEnvelope): number => (event.payload as { n: number }).n;

describe('EventBus', () => {
  it('delivers validated payloads in an envelope', async () => {
    const { bus } = setup();
    const seen: EventEnvelope[] = [];
    bus.subscribe('listener', 'counter.ticked', (event) => {
      seen.push(event);
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    await bus.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: 'counter.ticked',
      payload: { n: 1 },
      source: 'counter',
      depth: 0,
    });
    expect(seen[0]?.causedBy).toBeUndefined();
    expect(seen[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('never calls handlers synchronously inside emit', () => {
    const { bus } = setup();
    let called = false;
    bus.subscribe('listener', 'counter.ticked', () => {
      called = true;
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    expect(called).toBe(false);
  });

  it('throws ValidationError at the emitter for invalid payloads', () => {
    const { bus } = setup();
    expect(() => {
      bus.emit('counter', 'counter.ticked', { n: 'x' });
    }).toThrow(ValidationError);
  });

  it("rejects emitting another plugin's event and unknown events", () => {
    const { bus } = setup();
    expect(() => {
      bus.emit('listener', 'counter.ticked', { n: 1 });
    }).toThrow(AccessError);
    expect(() => {
      bus.emit('counter', 'counter.nope', {});
    }).toThrow(AccessError);
  });

  it('delivers events to each subscriber in emission order', async () => {
    const { bus } = setup();
    const order: number[] = [];
    bus.subscribe('listener', 'counter.ticked', async (event) => {
      await delay(n(event) === 1 ? 20 : 0);
      order.push(n(event));
    });
    for (const value of [1, 2, 3]) bus.emit('counter', 'counter.ticked', { n: value });
    await bus.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not let a slow handler delay other subscribers', async () => {
    const { bus } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fast: number[] = [];
    bus.subscribe('listener', 'counter.ticked', () => gate);
    bus.subscribe('other', 'counter.ticked', (event) => {
      fast.push(n(event));
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    await vi.waitFor(() => {
      expect(fast).toEqual([1]);
    });
    release();
    await bus.idle();
  });

  it('isolates and logs throwing handlers', async () => {
    const { bus, logger } = setup();
    const seen: number[] = [];
    bus.subscribe('listener', 'counter.ticked', () => {
      throw new Error('boom');
    });
    bus.subscribe('other', 'counter.ticked', (event) => {
      seen.push(n(event));
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    bus.emit('counter', 'counter.ticked', { n: 2 });
    await bus.idle();
    expect(seen).toEqual([1, 2]);
    const failures = logger.entries.filter((e) => e.message === 'Event handler failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]?.data).toMatchObject({
      plugin: 'listener',
      event: 'counter.ticked',
      error: 'boom',
    });
  });

  it('sets causedBy and depth for events emitted from handlers, across awaits', async () => {
    const { bus } = setup();
    const heard: EventEnvelope[] = [];
    let root: EventEnvelope | undefined;
    bus.subscribe('listener', 'counter.ticked', async (event) => {
      root = event;
      await delay(1);
      bus.emit('listener', 'listener.heard', { n: n(event) });
    });
    bus.subscribe('other', 'listener.heard', (event) => {
      heard.push(event);
    });
    bus.emit('counter', 'counter.ticked', { n: 7 });
    await bus.idle();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ causedBy: root?.id, depth: 1, payload: { n: 7 } });
  });

  it('drops events beyond the causation depth limit', async () => {
    const { bus, logger } = setup(3);
    const depths: number[] = [];
    bus.subscribe('counter', 'counter.ticked', (event) => {
      depths.push(event.depth);
      bus.emit('counter', 'counter.ticked', { n: n(event) + 1 });
    });
    bus.emit('counter', 'counter.ticked', { n: 0 });
    await bus.idle();
    expect(depths).toEqual([0, 1, 2, 3]);
    expect(
      logger.entries.some((e) => e.message === 'Dropped event: causation depth exceeded'),
    ).toBe(true);
  });

  it('stops delivery and settles idle() when unsubscribed with queued events', async () => {
    const { bus } = setup();
    const seen: number[] = [];
    const dispose = bus.subscribe('listener', 'counter.ticked', (event) => {
      seen.push(n(event));
      dispose();
    });
    for (const value of [1, 2, 3]) bus.emit('counter', 'counter.ticked', { n: value });
    await bus.idle();
    expect(seen).toEqual([1]);
    bus.emit('counter', 'counter.ticked', { n: 4 });
    await bus.idle();
    expect(seen).toEqual([1]);
  });

  it('passes every event to taps until disposed', () => {
    const { bus } = setup();
    const names: string[] = [];
    const dispose = bus.tap((event) => {
      names.push(event.name);
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    dispose();
    bus.emit('counter', 'counter.ticked', { n: 2 });
    expect(names).toEqual(['counter.ticked']);
  });

  it('resolves idle() immediately when nothing is queued', async () => {
    const { bus } = setup();
    await expect(bus.idle()).resolves.toBeUndefined();
  });

  it('runs its own bookkeeping outside the emitting plugin', async () => {
    const contracts = new ContractRegistry();
    contracts.register(counterContract);
    contracts.register(listenerContract);
    const scopes: (string | undefined)[] = [];
    const bus = new EventBus({
      contracts,
      logger: createMemoryLogger(),
      onHandlerError: () => {
        scopes.push(currentPlugin());
      },
    });
    bus.subscribe('listener', 'counter.ticked', () => {
      throw new Error('boom');
    });
    runInPlugin('counter', () => {
      bus.emit('counter', 'counter.ticked', { n: 1 });
    });
    await bus.idle();
    expect(scopes).toEqual([undefined]);
  });
});

describe('EventBus channels', () => {
  const setup = () => {
    const contracts = new ContractRegistry();
    contracts.register(counterContract);
    contracts.register(listenerContract);
    return new EventBus({ contracts, logger: createMemoryLogger() });
  };

  it('delivers items in order, as the channel owner, counted by idle', async () => {
    const bus = setup();
    const seen: string[] = [];
    const channel = bus.channel<string>('counter', 'test', async (item) => {
      await delay(item === 'a' ? 5 : 0);
      seen.push(`${item} as ${currentPlugin() ?? 'nobody'}`);
    });
    runInPlugin('listener', () => {
      channel.push('a');
      channel.push('b');
    });
    await bus.idle();
    expect(seen).toEqual(['a as counter', 'b as counter']);
  });

  it('keeps the causation of the push for events the handler emits', async () => {
    const bus = setup();
    const envelopes: EventEnvelope[] = [];
    bus.tap((envelope) => envelopes.push(envelope));
    const channel = bus.channel<string>('counter', 'test', () => {
      bus.emit('counter', 'counter.ticked', { n: 2 });
    });
    bus.subscribe('listener', 'counter.ticked', (event) => {
      if (event.depth === 0) channel.push('again');
    });
    bus.emit('counter', 'counter.ticked', { n: 1 });
    await bus.idle();
    expect(envelopes.map((envelope) => envelope.depth)).toEqual([0, 1]);
    expect(envelopes[1]?.causedBy).toBe(envelopes[0]?.id);
  });

  it('drops queued items on dispose and settles idle', async () => {
    const bus = setup();
    const seen: string[] = [];
    const channel = bus.channel<string>('counter', 'test', (item) => {
      seen.push(item);
    });
    channel.push('a');
    channel.dispose();
    channel.push('b');
    await bus.idle();
    expect(seen).toEqual([]);
  });
});
