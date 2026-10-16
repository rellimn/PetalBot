import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { defineContract, definePlugin, type Logger } from '@petalbot/sdk';
import { Kernel } from '../../src/kernel.ts';
import type { OverlayBundleInfo, PluginInfo } from '../../src/plugin-manager.ts';
import {
  ClientGateway,
  type ClientTransport,
  type GatewayOverlays,
  type GatewayPlugins,
} from '../../src/server/gateway/gateway.ts';

import type { ClientIdentity } from '../../src/server/identity.ts';
import { createMemoryLogger, type LogEntry } from '../helpers.ts';
import { alertsPlugin, modUser, ownerUser, type AlertsApi } from './fixtures.ts';

type Message = Record<string, unknown>;

class FakeTransport implements ClientTransport {
  readonly messages: Message[] = [];
  bufferedAmount = 0;
  closed: { code: number; reason: string } | undefined;

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Message);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  ofType(type: string): Message[] {
    return this.messages.filter((message) => message.type === type);
  }

  reply(id: string): Message | undefined {
    return this.messages.find((message) => message.type === 'reply' && message.id === id);
  }
}

const asOwner: ClientIdentity = { kind: 'panel', sessionId: 's1', user: ownerUser };
const asMod: ClientIdentity = { kind: 'panel', sessionId: 's2', user: modUser };
const asOverlay: ClientIdentity = {
  kind: 'overlay',
  instanceId: 'i1',
  pluginId: 'alerts',
  overlay: 'box',
};
const otherOverlay: ClientIdentity = {
  kind: 'overlay',
  instanceId: 'i2',
  pluginId: 'quotes',
  overlay: 'box',
};

function fakeOverlays(configs: Record<string, Record<string, unknown>>) {
  const listeners = new Set<(instance: { id: string; config: Record<string, unknown> }) => void>();
  const source: GatewayOverlays = {
    get: (id) => {
      const config = configs[id];
      return config === undefined ? undefined : { config };
    },
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    update(id: string, config: Record<string, unknown>) {
      configs[id] = config;
      for (const listener of listeners) listener({ id, config });
    },
  };
}

const bundle: OverlayBundleInfo = {
  hash: 'h1',
  entry: '/plugins/alerts/overlays/box/h1/box.js',
  styles: [],
};

async function setup(
  options: {
    maxConcurrentRpcs?: number;
    slow?: Promise<void>;
    overlays?: GatewayOverlays;
    bundles?: Record<string, OverlayBundleInfo>;
    logger?: Logger;
  } = {},
) {
  const kernel = new Kernel({ logger: createMemoryLogger() });
  const api: Partial<AlertsApi> = {};
  const start = () =>
    kernel.start(
      alertsPlugin({
        onSetup: (handle) => {
          Object.assign(api, handle);
        },
        ...(options.slow ? { slow: options.slow } : {}),
      }),
    );
  await start();
  const changes = new Set<(info: PluginInfo) => void>();
  const removals = new Set<(id: string) => void>();
  const plugins: GatewayPlugins = {
    onChange: (listener) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    onRemoved: (listener) => {
      removals.add(listener);
      return () => {
        removals.delete(listener);
      };
    },
    overlayBundle: (pluginId, overlay) => options.bundles?.[`${pluginId}/${overlay}`],
  };
  const gateway = new ClientGateway({
    kernel,
    plugins,
    logger: options.logger ?? createMemoryLogger(),
    ...(options.overlays ? { overlays: options.overlays } : {}),
    ...(options.maxConcurrentRpcs === undefined
      ? {}
      : { maxConcurrentRpcs: options.maxConcurrentRpcs }),
  });
  const connect = (identity: ClientIdentity) => {
    const transport = new FakeTransport();
    const connection = gateway.connect(identity, transport);
    const send = (message: object) => {
      connection.receive(JSON.stringify(message));
    };
    return { transport, connection, send };
  };
  return {
    kernel,
    gateway,
    connect,
    start,
    shown: (text: string) => {
      api.shown?.(text);
    },
    internal: () => {
      api.internal?.();
    },
    stamped: (at: Date) => {
      api.stamped?.(at);
    },
    broken: () => {
      api.broken?.();
    },
    changed: (info: PluginInfo) => {
      for (const listener of changes) listener(info);
    },
    removed: (id: string) => {
      for (const listener of removals) listener(id);
    },
  };
}

describe('ClientGateway', () => {
  it('greets with the identity, without the session id', async () => {
    const { connect } = await setup();
    expect(connect(asOwner).transport.messages[0]).toEqual({
      type: 'hello',
      identity: { kind: 'panel', user: ownerUser },
    });
    expect(connect(asOverlay).transport.messages[0]).toEqual({
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
    expect(connect({ ...asOverlay, sessionId: 's1' }).transport.messages[0]).toMatchObject({
      identity: { kind: 'overlay', preview: true },
    });
  });

  it('greets overlays with their config and bundle, and pushes config changes', async () => {
    const overlays = fakeOverlays({ i1: { durationMs: 1 }, i2: {} });
    const { connect } = await setup({
      overlays: overlays.source,
      bundles: { 'alerts/box': bundle },
    });
    const overlay = connect(asOverlay);
    const other = connect({ ...asOverlay, instanceId: 'i2' });
    const panel = connect(asOwner);
    expect(overlay.transport.messages[0]).toMatchObject({
      overlay: { config: { durationMs: 1 }, bundle },
    });
    overlays.update('i1', { durationMs: 2 });
    expect(overlay.transport.ofType('overlay.config')).toEqual([
      { type: 'overlay.config', config: { durationMs: 2 } },
    ]);
    expect(other.transport.ofType('overlay.config')).toEqual([]);
    expect(panel.transport.ofType('overlay.config')).toEqual([]);
  });

  it('delivers subscribed events that are exposed to the panel', async () => {
    const { connect, shown } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'subscribe', id: '1', event: 'alerts.shown' });
    expect(transport.reply('1')).toEqual({ type: 'reply', id: '1', result: null });
    shown('hi');
    expect(transport.ofType('event')).toMatchObject([
      { envelope: { name: 'alerts.shown', payload: { text: 'hi' }, source: 'alerts' } },
    ]);
    send({ type: 'unsubscribe', id: '2', event: 'alerts.shown' });
    shown('again');
    expect(transport.ofType('event')).toHaveLength(1);
  });

  it('refuses events that are not exposed, unknown or of stopped plugins', async () => {
    const { connect } = await setup();
    const { transport, send } = connect(asOwner);
    send({ type: 'subscribe', id: '1', event: 'alerts.internal' });
    send({ type: 'subscribe', id: '2', event: 'alerts.nope' });
    send({ type: 'subscribe', id: '3', event: 'chat.message' });
    expect(transport.reply('1')).toMatchObject({ error: { code: 'forbidden' } });
    expect(transport.reply('2')).toMatchObject({ error: { code: 'not_found' } });
    expect(transport.reply('3')).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('checks the role each RPC needs and tells the plugin who called', async () => {
    const { connect } = await setup();
    const mod = connect(asMod);
    mod.send({ type: 'rpc', id: '1', name: 'alerts.clear', input: {} });
    mod.send({ type: 'rpc', id: '2', name: 'alerts.hidden', input: {} });
    mod.send({ type: 'rpc', id: '3', name: 'alerts.whoami', input: {} });
    const owner = connect(asOwner);
    owner.send({ type: 'rpc', id: '4', name: 'alerts.clear', input: {} });
    await vi.waitFor(() => {
      expect(mod.transport.reply('1')).toMatchObject({ error: { code: 'forbidden' } });
      expect(mod.transport.reply('2')).toMatchObject({ error: { code: 'forbidden' } });
      expect(mod.transport.reply('3')).toEqual({
        type: 'reply',
        id: '3',
        result: { caller: 'client', who: 'mia', client: { kind: 'panel', user: modUser } },
      });
      expect(owner.transport.reply('4')).toEqual({
        type: 'reply',
        id: '4',
        result: { cleared: 3 },
      });
    });
  });

  it('reports invalid RPC input as a validation error', async () => {
    const { connect } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'rpc', id: '1', name: 'alerts.recent', input: { limit: 'three' } });
    await vi.waitFor(() => {
      expect(transport.reply('1')).toMatchObject({ error: { code: 'validation' } });
    });
  });

  it('calls RPCs without input when the frame has no input', async () => {
    const { connect } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'rpc', id: '1', name: 'alerts.ping' });
    send({ type: 'rpc', id: '2', name: 'alerts.ping', input: { x: 1 } });
    await vi.waitFor(() => {
      expect(transport.reply('1')).toEqual({ type: 'reply', id: '1', result: 'pong' });
      expect(transport.reply('2')).toMatchObject({ error: { code: 'validation' } });
    });
  });

  it('answers malformed messages and closes the socket on garbage', async () => {
    const { connect } = await setup();
    const a = connect(asMod);
    a.send({ type: 'dance', id: '1' });
    expect(a.transport.reply('1')).toMatchObject({ error: { code: 'invalid_message' } });
    expect(a.transport.closed).toBeUndefined();
    const b = connect(asMod);
    b.connection.receive('not json');
    expect(b.transport.closed).toEqual({ code: 1007, reason: 'Malformed JSON' });
    const c = connect(asMod);
    c.send({ type: 'subscribe' });
    expect(c.transport.closed?.code).toBe(1007);
  });

  it('limits concurrent RPCs per connection', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connect } = await setup({ maxConcurrentRpcs: 1, slow });
    const { transport, send } = connect(asMod);
    send({ type: 'rpc', id: '1', name: 'alerts.slow', input: {} });
    send({ type: 'rpc', id: '2', name: 'alerts.slow', input: {} });
    await vi.waitFor(() => {
      expect(transport.reply('2')).toMatchObject({ error: { code: 'busy' } });
    });
    release();
    await vi.waitFor(() => {
      expect(transport.reply('1')).toEqual({ type: 'reply', id: '1', result: {} });
    });
  });

  it("limits overlays to their declaration's events and RPCs", async () => {
    const { connect, shown } = await setup();
    const { transport, send } = connect(asOverlay);
    send({ type: 'subscribe', id: '1', event: 'alerts.shown' });
    send({ type: 'subscribe', id: '2', event: 'alerts.internal' });
    send({ type: 'rpc', id: '3', name: 'alerts.recent', input: { limit: 1 } });
    send({ type: 'rpc', id: '4', name: 'alerts.clear', input: {} });
    send({ type: 'rpc', id: '5', name: 'alerts.whoami', input: {} });
    shown('hi');
    await vi.waitFor(() => {
      expect(transport.reply('1')).toMatchObject({ result: null });
      expect(transport.reply('2')).toMatchObject({ error: { code: 'forbidden' } });
      expect(transport.reply('3')).toMatchObject({ result: ['a'] });
      expect(transport.reply('4')).toMatchObject({ error: { code: 'forbidden' } });
      expect(transport.reply('5')).toMatchObject({
        result: { who: 'overlay', client: { kind: 'overlay', instanceId: 'i1' } },
      });
    });
    expect(transport.ofType('event')).toHaveLength(1);
  });

  it('streams every event to owners who inspect, and only to them', async () => {
    const { connect, internal } = await setup();
    const owner = connect(asOwner);
    owner.send({ type: 'inspect', id: '1' });
    const mod = connect(asMod);
    mod.send({ type: 'inspect', id: '1' });
    internal();
    expect(owner.transport.ofType('inspect.event')).toMatchObject([
      { envelope: { name: 'alerts.internal' } },
    ]);
    expect(mod.transport.reply('1')).toMatchObject({ error: { code: 'forbidden' } });
    expect(mod.transport.ofType('inspect.event')).toEqual([]);
  });

  it('announces plugin changes to the panel and to overlays of that plugin', async () => {
    const { connect, changed, removed } = await setup({ bundles: { 'alerts/box': bundle } });
    const panel = connect(asMod);
    const overlay = connect(asOverlay);
    const other = connect(otherOverlay);
    const info: PluginInfo = {
      id: 'alerts',
      version: '1.0.0',
      dir: '/plugins/alerts',
      state: 'stopping',
      enabled: true,
      degraded: false,
      dependencies: [],
      optionalDependencies: [],
      hasPanel: false,
    };
    changed(info);
    removed('alerts');
    expect(panel.transport.ofType('plugin.state')).toEqual([
      { type: 'plugin.state', plugin: info },
    ]);
    expect(panel.transport.ofType('plugin.removed')).toEqual([
      { type: 'plugin.removed', id: 'alerts' },
    ]);
    expect(overlay.transport.ofType('plugin.state')).toEqual([
      { type: 'plugin.state', plugin: { id: 'alerts', state: 'stopping', bundle: null } },
    ]);
    expect(overlay.transport.ofType('plugin.removed')).toEqual([]);
    expect(other.transport.ofType('plugin.state')).toEqual([]);
    changed({ ...info, state: 'running' });
    expect(overlay.transport.ofType('plugin.state').at(-1)).toEqual({
      type: 'plugin.state',
      plugin: { id: 'alerts', state: 'running', bundle },
    });
  });

  it('keeps subscriptions while a plugin restarts and checks exposure again on delivery', async () => {
    const { connect, kernel, shown, start } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'subscribe', id: '1', event: 'alerts.shown' });
    await kernel.stop('alerts');
    await start();
    shown('back');
    expect(transport.ofType('event')).toHaveLength(1);

    await kernel.stop('alerts');
    const unexposed = defineContract({
      id: 'alerts',
      version: '1.1.0',
      events: { shown: { schema: z.object({ text: z.string() }) } },
    });
    let emit: () => void = () => undefined;
    await kernel.start(
      definePlugin(unexposed, {
        setup(ctx) {
          emit = () => {
            ctx.emit('alerts.shown', { text: 'secret' });
          };
        },
      }),
    );
    emit();
    expect(transport.ofType('event')).toHaveLength(1);
  });

  it('disconnects clients that do not read fast enough', async () => {
    const { connect, shown } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'subscribe', id: '1', event: 'alerts.shown' });
    transport.bufferedAmount = 5 * 1024 * 1024;
    shown('flood');
    expect(transport.closed).toEqual({ code: 1013, reason: 'Client is not reading fast enough' });
  });

  it('closes the connections a predicate selects', async () => {
    const { gateway, connect } = await setup();
    const a = connect(asOwner);
    const b = connect(asMod);
    gateway.closeWhere(
      (identity) => identity.kind === 'panel' && identity.sessionId === 's1',
      4001,
      'Session ended',
    );
    expect(a.transport.closed).toEqual({ code: 4001, reason: 'Session ended' });
    expect(b.transport.closed).toBeUndefined();
    expect(gateway.size).toBe(1);
  });
  it('encodes payloads and results for browsers with their schema', async () => {
    const { connect, stamped } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'subscribe', id: '1', event: 'alerts.stamped' });
    stamped(new Date('2026-10-12T18:30:00.000Z'));
    send({ type: 'rpc', id: '2', name: 'alerts.when', input: {} });
    await vi.waitFor(() => {
      expect(transport.ofType('event')).toMatchObject([
        { envelope: { name: 'alerts.stamped', payload: { at: '2026-10-12T18:30:00.000Z' } } },
      ]);
      expect(transport.reply('2')).toEqual({
        type: 'reply',
        id: '2',
        result: { at: '2026-10-12T18:30:00.000Z' },
      });
    });
  });

  it('encodes a failure detail codec without requiring diagnostics', async () => {
    const { connect } = await setup();
    const { transport, send } = connect(asMod);
    send({ type: 'rpc', id: 'late', name: 'alerts.late' });
    await vi.waitFor(() => {
      expect(transport.reply('late')).toEqual({
        type: 'reply',
        id: 'late',
        result: {
          ok: false,
          reason: 'custom',
          error: { code: 'late', at: '2026-10-16T10:00:00.000Z' },
        },
      });
    });
  });

  it('refuses to send what a schema cannot encode, and says why once', async () => {
    const entries: LogEntry[] = [];
    const { connect, broken } = await setup({ logger: createMemoryLogger(entries) });
    const first = connect(asMod);
    const second = connect(asOwner);
    first.send({ type: 'subscribe', id: '1', event: 'alerts.broken' });
    second.send({ type: 'subscribe', id: '1', event: 'alerts.broken' });
    broken();
    broken();
    first.send({ type: 'rpc', id: '2', name: 'alerts.lengths', input: {} });
    await vi.waitFor(() => {
      expect(first.transport.reply('2')).toMatchObject({
        error: { code: 'internal', message: expect.stringContaining('alerts.lengths') as string },
      });
    });
    expect(first.transport.ofType('event')).toEqual([]);
    expect(second.transport.ofType('event')).toEqual([]);
    expect(
      entries.filter((entry) => entry.message === 'An event cannot be encoded for browsers'),
    ).toHaveLength(1);
  });
});
