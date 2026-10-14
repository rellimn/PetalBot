import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer, type RunningServer } from '../../src/server/server.ts';
import { delay } from '../helpers.ts';
import { alertsPlugin, modUser, ownerUser } from './fixtures.ts';
import { ORIGIN, createTestServer, type TestServer } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

interface Client {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[];
  readonly closed: Promise<{ code: number; reason: string }>;
}

function open(url: string, headers: Record<string, string> = {}, origin = ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers });
    const messages: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.on('close', (code, reason) => {
        done({ code, reason: reason.toString() });
      });
    });
    ws.on('message', (data) => {
      messages.push(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
    });
    ws.once('open', () => {
      resolve({ ws, messages, closed });
    });
    ws.once('error', reject);
  });
}

/** Resolves with the HTTP status of a refused upgrade. */
function refusal(
  url: string,
  headers: Record<string, string> = {},
  origin = ORIGIN,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers });
    ws.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      reject(new Error('The upgrade was accepted'));
    });
    ws.on('error', () => undefined);
  });
}

interface Setup {
  readonly test: TestServer;
  readonly server: RunningServer;
  readonly wsUrl: string;
  teardown(): Promise<void>;
}

async function setup(options: { now?: () => number; heartbeatMs?: number } = {}): Promise<Setup> {
  const test = await createTestServer({
    definitions: { alerts: alertsPlugin() },
    ...(options.now ? { now: options.now } : {}),
  });
  const server = await startHttpServer({
    services: test.services,
    host: '127.0.0.1',
    port: 0,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  return {
    test,
    server,
    wsUrl: `${server.url.replace('http://', 'ws://')}/ws`,
    async teardown() {
      await server.close();
      await test.close();
    },
  };
}

describe('WebSocket server', () => {
  it('accepts panel sessions and overlay tokens', async () => {
    const s = await setup();
    await s.test.services.manager.enable('alerts');
    const panel = await open(s.wsUrl, { cookie: s.test.cookieFor(ownerUser) });
    const { token } = s.test.services.overlays.create('alerts', 'box', 'Main', {});
    const overlay = await open(`${s.wsUrl}?t=${token}`);
    await vi.waitFor(() => {
      expect(panel.messages[0]).toEqual({
        type: 'hello',
        identity: { kind: 'panel', user: ownerUser },
      });
      expect(overlay.messages[0]).toMatchObject({
        type: 'hello',
        identity: { kind: 'overlay', pluginId: 'alerts', overlay: 'box' },
      });
    });
    panel.ws.send(
      JSON.stringify({ type: 'rpc', id: '1', name: 'alerts.recent', input: { limit: 2 } }),
    );
    await vi.waitFor(() => {
      expect(panel.messages).toContainEqual({ type: 'reply', id: '1', result: ['a', 'b'] });
    });
    await s.teardown();
  });

  it('refuses other origins, missing or unknown credentials and other paths', async () => {
    const s = await setup();
    const cookie = s.test.cookieFor(ownerUser);
    expect(await refusal(s.wsUrl, { cookie }, 'https://evil.example')).toBe(403);
    expect(await refusal(s.wsUrl)).toBe(401);
    expect(await refusal(`${s.wsUrl}?t=guessed`)).toBe(401);
    expect(await refusal(s.wsUrl, { cookie: 'petalbot_session=forged' })).toBe(401);
    expect(await refusal(s.wsUrl.replace('/ws', '/elsewhere'), { cookie })).toBe(404);
    await s.teardown();
  });

  it('closes sockets of revoked sessions and overlay tokens', async () => {
    const s = await setup();
    const { token: sessionToken, session } = s.test.services.sessions.create(ownerUser);
    const panel = await open(s.wsUrl, { cookie: `petalbot_session=${sessionToken}` });
    const { instance, token } = s.test.services.overlays.create('alerts', 'box', 'Main', {});
    const overlay = await open(`${s.wsUrl}?t=${token}`);
    s.test.services.sessions.revoke(session.id);
    s.test.services.overlays.rotate(instance.id);
    await expect(panel.closed).resolves.toMatchObject({ code: 4001 });
    await expect(overlay.closed).resolves.toMatchObject({ code: 4003 });
    await s.teardown();
  });

  it('keeps sessions alive while connected and ends them when they expire', async () => {
    let now = Date.now();
    const s = await setup({ now: () => now, heartbeatMs: 20 });
    const panel = await open(s.wsUrl, { cookie: s.test.cookieFor(ownerUser) });
    // 4 x 6 days: far past the 7-day idle limit, but the heartbeat keeps refreshing the session.
    for (let step = 0; step < 4; step++) {
      now += 6 * DAY;
      await delay(80);
    }
    expect(panel.ws.readyState).toBe(WebSocket.OPEN);
    now += 7 * DAY; // 31 days after login: past the 30-day maximum
    await expect(panel.closed).resolves.toMatchObject({ code: 4001 });
    await s.teardown();
  });

  it('closes every socket with 1001 when the server shuts down', async () => {
    const s = await setup();
    const panel = await open(s.wsUrl, { cookie: s.test.cookieFor(ownerUser) });
    await s.server.close();
    await expect(panel.closed).resolves.toMatchObject({ code: 1001 });
    await s.test.close();
  });

  it(
    'does not let a client that ignores the close frame stall shutdown',
    { timeout: 10_000 },
    async () => {
      const s = await setup();
      const { port } = new URL(s.server.url);
      const socket = connect(Number(port), '127.0.0.1');
      const upgraded = new Promise<void>((resolve) => {
        socket.once('data', () => {
          resolve();
        });
      });
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Origin: ${ORIGIN}`,
          `Cookie: ${s.test.cookieFor(ownerUser)}`,
          '',
          '',
        ].join('\r\n'),
      );
      await upgraded; // 101 received; from now on this client never answers anything
      const started = Date.now();
      await s.server.close();
      expect(Date.now() - started).toBeLessThan(5000);
      socket.destroy();
      await s.test.close();
    },
  );
  it('opens live previews for owners, without the token', async () => {
    const s = await setup();
    const { instance } = s.test.services.overlays.create('alerts', 'box', 'Main', {
      durationMs: 7,
    });
    const url = `${s.wsUrl}?preview=${instance.id}`;
    const preview = await open(url, { cookie: s.test.cookieFor(ownerUser) });
    await vi.waitFor(() => {
      expect(preview.messages[0]).toEqual({
        type: 'hello',
        identity: {
          kind: 'overlay',
          instanceId: instance.id,
          pluginId: 'alerts',
          overlay: 'box',
          preview: true,
        },
        overlay: { config: { durationMs: 7 }, bundle: null },
      });
    });
    expect(await refusal(url)).toBe(401);
    expect(await refusal(url, { cookie: s.test.cookieFor(modUser) })).toBe(403);
    expect(
      await refusal(`${s.wsUrl}?preview=missing`, { cookie: s.test.cookieFor(ownerUser) }),
    ).toBe(404);
    await s.teardown();
  });

  it('closes previews when the instance is revoked or the session ends, not when rotated', async () => {
    const s = await setup();
    const { token: sessionToken, session } = s.test.services.sessions.create(ownerUser);
    const { instance, token } = s.test.services.overlays.create('alerts', 'box', 'Main', {});
    const preview = await open(`${s.wsUrl}?preview=${instance.id}`, {
      cookie: `petalbot_session=${sessionToken}`,
    });
    const obs = await open(`${s.wsUrl}?t=${token}`);
    s.test.services.overlays.rotate(instance.id);
    await expect(obs.closed).resolves.toMatchObject({ code: 4003 });
    expect(preview.ws.readyState).toBe(WebSocket.OPEN);
    s.test.services.sessions.revoke(session.id);
    await expect(preview.closed).resolves.toMatchObject({ code: 4001 });

    const second = await open(`${s.wsUrl}?preview=${instance.id}`, {
      cookie: s.test.cookieFor(ownerUser),
    });
    s.test.services.overlays.revoke(instance.id);
    await expect(second.closed).resolves.toMatchObject({ code: 4003 });
    await s.teardown();
  });

  it('pushes config changes to open overlays', async () => {
    const s = await setup();
    await s.test.services.manager.enable('alerts');
    const { instance, token } = s.test.services.overlays.create('alerts', 'box', 'Main', {});
    const overlay = await open(`${s.wsUrl}?t=${token}`);
    s.test.services.overlays.update(instance.id, { config: { durationMs: 9 } });
    await vi.waitFor(() => {
      expect(overlay.messages).toContainEqual({
        type: 'overlay.config',
        config: { durationMs: 9 },
      });
    });
    await s.teardown();
  });
});
