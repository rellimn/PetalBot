import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PetalConnection,
  type ConnectionOptions,
  type ConnectionState,
} from '../src/client/connection.ts';
import { ClientError } from '../src/client/errors.ts';
import type { PluginInfo, PluginList } from '../src/client/types.ts';
import { FakeSocket } from './fake-socket.ts';

const plugin = (id: string, state: PluginInfo['state'] = 'running'): PluginInfo => ({
  id,
  version: '1.0.0',
  dir: `/plugins/${id}`,
  state,
  enabled: state !== 'disabled',
  degraded: false,
  dependencies: [],
  optionalDependencies: [],
  hasPanel: false,
});

function connect(options: Partial<ConnectionOptions> = {}) {
  const connection = new PetalConnection({
    url: 'ws://panel.test/ws',
    createSocket: (url) => new FakeSocket(url),
    ...options,
  });
  connection.start();
  return { connection, socket: FakeSocket.latest() };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PetalConnection', () => {
  it('opens on hello, calls RPCs and maps error replies to ClientError', async () => {
    const { connection, socket } = connect();
    expect(connection.status).toBe('connecting');
    socket.hello();
    expect(connection.status).toBe('open');
    expect(connection.identity).toMatchObject({ kind: 'panel', user: { name: 'roman' } });

    const ok = connection.call('quotes.list', { limit: 2 });
    expect(socket.ofType('rpc').at(-1)).toMatchObject({ name: 'quotes.list', input: { limit: 2 } });
    socket.answer('rpc', ['a', 'b']);
    await expect(ok).resolves.toEqual(['a', 'b']);

    const denied = connection.call('quotes.clear', {});
    socket.fail('rpc', 'forbidden', 'Owners only');
    await expect(denied).rejects.toEqual(new ClientError('forbidden', 'Owners only'));
  });

  it('queues calls until the connection is open and times out unanswered ones', async () => {
    const { connection, socket } = connect({ callTimeoutMs: 1000 });
    const early = connection.call('quotes.list', {});
    expect(socket.sent).toEqual([]);
    socket.hello();
    expect(socket.ofType('rpc')).toHaveLength(1);
    socket.answer('rpc', 1);
    await expect(early).resolves.toBe(1);

    const slow = connection.call('quotes.slow', {});
    const result = expect(slow).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
  });

  it('reconnects with backoff, resubscribes and sends queued calls', async () => {
    const { connection, socket } = connect();
    const events: unknown[] = [];
    connection.subscribe('quotes.added', (event) => events.push(event.payload));
    socket.hello();
    expect(socket.ofType('subscribe')).toMatchObject([{ event: 'quotes.added' }]);

    const inFlight = connection.call('quotes.list', {});
    const lost = expect(inFlight).rejects.toMatchObject({ code: 'unavailable' });
    socket.drop();
    await lost;
    expect(connection.status).toBe('reconnecting');

    const queued = connection.call('quotes.add', { text: 'hi' });
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const second = FakeSocket.latest();
    second.drop(); // the attempt fails before hello
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = FakeSocket.latest();
    third.hello();
    expect(connection.status).toBe('open');
    expect(third.ofType('subscribe')).toMatchObject([{ event: 'quotes.added' }]);
    expect(third.ofType('rpc')).toMatchObject([{ name: 'quotes.add' }]);
    third.answer('rpc', { ok: true });
    await expect(queued).resolves.toEqual({ ok: true });

    third.receive({
      type: 'event',
      envelope: {
        id: '1',
        name: 'quotes.added',
        payload: { text: 'x' },
        source: 'quotes',
        timestamp: 1,
        depth: 0,
      },
    });
    expect(events).toEqual([{ text: 'x' }]);
  });

  it('caps the backoff at maxMs', async () => {
    connect({ backoff: { initialMs: 100, maxMs: 300 } }).socket.drop();
    for (const delay of [100, 200, 300, 300]) {
      const before = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeSocket.all).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all).toHaveLength(before + 1);
      FakeSocket.latest().drop();
    }
  });

  it('subscribes again when the owning plugin runs again', () => {
    const { connection, socket } = connect({
      loadPlugins: () => Promise.resolve({ plugins: [], problems: [] }),
    });
    connection.subscribe('quotes.added', () => undefined);
    socket.hello();
    socket.fail('subscribe', 'unavailable', 'Plugin "quotes" is not running');
    socket.receive({ type: 'plugin.state', plugin: plugin('chat') });
    expect(socket.ofType('subscribe')).toHaveLength(1);
    socket.receive({ type: 'plugin.state', plugin: plugin('quotes') });
    expect(socket.ofType('subscribe')).toHaveLength(2);
  });

  it('unsubscribes when the last listener leaves', () => {
    const { connection, socket } = connect();
    socket.hello();
    const offA = connection.subscribe('quotes.added', () => undefined);
    const offB = connection.subscribe('quotes.added', () => undefined);
    expect(socket.ofType('subscribe')).toHaveLength(1);
    offA();
    expect(socket.ofType('unsubscribe')).toHaveLength(0);
    offB();
    expect(socket.ofType('unsubscribe')).toMatchObject([{ event: 'quotes.added' }]);
  });

  it('ends without reconnecting when the session ended', async () => {
    const { connection, socket } = connect();
    socket.hello();
    const pending = connection.call('quotes.list', {});
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
    socket.drop(4001);
    await rejected;
    expect(connection.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    await expect(connection.call('quotes.list', {})).rejects.toMatchObject({
      code: 'unauthorized',
    });

    connection.restart();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.latest().hello();
    expect(connection.status).toBe('open');
  });

  it('asks the probe after a failed attempt and ends when it says so', async () => {
    const probe = vi.fn(() => Promise.resolve<'retry' | 'ended'>('ended'));
    const { connection, socket } = connect({ probe });
    socket.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledOnce();
    expect(connection.status).toBe('ended');
  });

  it('merges the plugin list with updates that arrive while it loads', async () => {
    let resolveList: (list: PluginList) => void = () => undefined;
    const { connection, socket } = connect({
      loadPlugins: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });
    const changes = vi.fn();
    connection.state.subscribe(changes);
    expect(connection.pluginsLoaded).toBe(false);
    socket.hello();
    socket.receive({ type: 'plugin.state', plugin: plugin('quotes', 'stopping') });
    resolveList({
      plugins: [plugin('quotes', 'running'), plugin('chat')],
      problems: [{ dir: '/x', message: 'bad' }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect([...connection.plugins.values()].map((p) => [p.id, p.state])).toEqual([
      ['quotes', 'stopping'],
      ['chat', 'running'],
    ]);
    expect(connection.problems).toEqual([{ dir: '/x', message: 'bad' }]);
    expect(connection.pluginsLoaded).toBe(true);
    socket.receive({ type: 'plugin.removed', id: 'chat' });
    expect([...connection.plugins.keys()]).toEqual(['quotes']);
    expect(changes).toHaveBeenCalled();
  });

  it('streams logs while someone listens, also across reconnects', async () => {
    const { connection, socket } = connect();
    socket.hello();
    const entries: unknown[] = [];
    const off = connection.streamLogs((entry) => entries.push(entry.message));
    expect(socket.ofType('logs')).toMatchObject([{ enabled: true }]);
    socket.receive({
      type: 'log.entry',
      entry: { id: 1, time: 1, level: 'info', message: 'hello', data: {} },
    });
    expect(entries).toEqual(['hello']);
    socket.drop();
    await vi.advanceTimersByTimeAsync(500);
    FakeSocket.latest().hello();
    expect(FakeSocket.latest().ofType('logs')).toMatchObject([{ enabled: true }]);
    off();
    expect(FakeSocket.latest().ofType('logs')).toMatchObject([
      { enabled: true },
      { enabled: false },
    ]);
  });

  it('stops for good', async () => {
    const { connection, socket } = connect();
    socket.hello();
    connection.stop();
    expect(socket.closedByClient).toBe(true);
    socket.drop(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
  it('publishes its state as one store and keeps unchanged plugin entries', async () => {
    const { connection, socket } = connect({
      loadPlugins: () =>
        Promise.resolve({ plugins: [plugin('quotes'), plugin('chat')], problems: [] }),
    });
    const states: ConnectionState[] = [];
    connection.state.subscribe((state) => {
      states.push(state);
    });
    socket.hello();
    await vi.advanceTimersByTimeAsync(0);
    // 'open' first, then the loaded list in one change
    expect(states.map((state) => [state.status, state.pluginsLoaded])).toEqual([
      ['open', false],
      ['open', true],
    ]);
    const quotes = connection.plugins.get('quotes');
    socket.receive({ type: 'plugin.state', plugin: plugin('chat', 'stopping') });
    expect(connection.plugins.get('quotes')).toBe(quotes);
    expect(connection.plugins.get('chat')?.state).toBe('stopping');
    expect(connection.state.get()).toMatchObject({
      status: 'open',
      pluginsLoaded: true,
      problems: [],
    });
  });
  it('tracks the overlay session from hello, overlay.config and plugin.state', () => {
    const { connection, socket } = connect({ url: 'ws://host.test/ws?t=x' });
    const changes: unknown[] = [];
    connection.state.subscribe((state, previous) => {
      if (state.overlay !== previous.overlay) changes.push(state.overlay);
    });
    expect(connection.overlay).toBeUndefined();
    const bundle = { hash: 'h1', entry: '/plugins/alerts/overlays/box/h1/box.js', styles: [] };
    socket.receive({
      type: 'hello',
      identity: {
        kind: 'overlay',
        instanceId: 'i1',
        pluginId: 'alerts',
        overlay: 'box',
        preview: false,
      },
      overlay: { config: { durationMs: 1 }, bundle },
    });
    expect(connection.status).toBe('open');
    expect(connection.overlay).toEqual({ config: { durationMs: 1 }, bundle });

    socket.receive({ type: 'overlay.config', config: { durationMs: 2 } });
    expect(connection.overlay).toEqual({ config: { durationMs: 2 }, bundle });

    socket.receive({
      type: 'plugin.state',
      plugin: { id: 'alerts', state: 'stopping', bundle: null },
    });
    expect(connection.overlay?.bundle).toBeNull();
    socket.receive({
      type: 'plugin.state',
      plugin: { id: 'alerts', state: 'disabled', bundle: null },
    });
    const next = { ...bundle, hash: 'h2' };
    socket.receive({
      type: 'plugin.state',
      plugin: { id: 'alerts', state: 'running', bundle: next },
    });
    expect(connection.overlay?.bundle).toEqual(next);
    // hello, config, stop (the second 'no bundle' changes nothing), new bundle
    expect(changes).toHaveLength(4);
  });

  it('ignores overlay messages on panel connections', () => {
    const { connection, socket } = connect();
    socket.hello();
    socket.receive({ type: 'overlay.config', config: { a: 1 } });
    expect(connection.overlay).toBeUndefined();
  });

  it('ends for good when the overlay token is revoked or rotated', async () => {
    const { connection, socket } = connect({ url: 'ws://host.test/ws?t=x' });
    socket.receive({
      type: 'hello',
      identity: {
        kind: 'overlay',
        instanceId: 'i1',
        pluginId: 'alerts',
        overlay: 'box',
        preview: false,
      },
      overlay: { config: {}, bundle: null },
    });
    socket.drop(4003);
    expect(connection.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
