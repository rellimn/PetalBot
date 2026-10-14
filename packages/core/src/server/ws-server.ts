import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { parse as parseCookies } from 'hono/utils/cookie';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Logger } from '@petalbot/sdk';
import { errorMessage } from '../names.ts';
import type { SessionStore } from './auth/session-store.ts';
import type { ClientGateway } from './gateway/gateway.ts';
import { CLOSE, PROTOCOL_LIMITS } from './gateway/protocol.ts';
import { SESSION_COOKIE } from './http/cookies.ts';
import type { ClientIdentity } from './identity.ts';
import type { OverlayInstanceStore } from './overlays/instance-store.ts';

export interface WebSocketServerOptions {
  readonly server: Server;
  readonly gateway: ClientGateway;
  readonly sessions: SessionStore;
  readonly overlays: OverlayInstanceStore;
  readonly publicOrigin: string;
  readonly logger: Logger;
  /** Ping interval; also when panel sessions are refreshed or ended. Default 30 000 ms. */
  readonly heartbeatMs?: number;
}

export interface AttachedWebSocketServer {
  /** Closes every socket with `code` and stops accepting upgrades. */
  close(code: number, reason: string): Promise<void>;
}

/** How long shutdown waits for clients to finish the close handshake. */
const CLOSE_GRACE_MS = 1000;

type UpgradeResult =
  | { readonly identity: ClientIdentity }
  | { readonly status: 401 | 403 | 404; readonly reason: string };

/** Accepts `/ws` upgrades after checking Origin and identity */
export function attachWebSocketServer(options: WebSocketServerOptions): AttachedWebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PROTOCOL_LIMITS.maxMessageBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  const accept = (ws: WebSocket, identity: ClientIdentity): void => {
    const connection = options.gateway.connect(identity, {
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    });
    alive.set(ws, true);
    ws.on('pong', () => {
      alive.set(ws, true);
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(CLOSE.invalidData, 'Binary frames are not supported');
        return;
      }
      connection.receive(rawToString(data));
    });
    ws.on('close', () => {
      connection.closed();
    });
    ws.on('error', (error) => {
      options.logger.warn('WebSocket error', { error: errorMessage(error) });
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const result = authenticate(request, options);
    if ('status' in result) {
      refuse(socket, result.status, result.reason);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, result.identity);
    });
  };
  options.server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) !== true) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
    // An open panel or preview counts as activity; expired or revoked sessions end here.
    options.gateway.closeWhere(
      (identity) =>
        identity.sessionId !== undefined &&
        options.sessions.touch(identity.sessionId) === undefined,
      CLOSE.sessionEnded,
      'Session ended',
    );
  }, options.heartbeatMs ?? PROTOCOL_LIMITS.heartbeatMs);
  heartbeat.unref();

  return {
    close(code, reason) {
      clearInterval(heartbeat);
      options.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(code, reason);
      // ws waits up to 30 s for each close handshake; a client that went away would stall the
      // shutdown past its deadline. Give clients a moment, then drop whoever is left.
      const grace = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, CLOSE_GRACE_MS);
      return new Promise((resolve) => {
        wss.close(() => {
          clearTimeout(grace);
          resolve();
        });
      });
    },
  };
}

function authenticate(request: IncomingMessage, options: WebSocketServerOptions): UpgradeResult {
  const url = new URL(request.url ?? '/', 'http://petalbot.invalid');
  if (url.pathname !== '/ws') return { status: 404, reason: 'Not Found' };
  if (request.headers.origin !== options.publicOrigin) return { status: 403, reason: 'Forbidden' };
  const token = url.searchParams.get('t');
  if (token !== null) {
    const instance = options.overlays.findByToken(token);
    if (!instance) return { status: 401, reason: 'Unauthorized' };
    return {
      identity: {
        kind: 'overlay',
        instanceId: instance.id,
        pluginId: instance.pluginId,
        overlay: instance.overlay,
      },
    };
  }
  const cookie = parseCookies(request.headers.cookie ?? '', SESSION_COOKIE)[SESSION_COOKIE];
  const session = cookie === undefined ? undefined : options.sessions.get(cookie);
  if (!session) return { status: 401, reason: 'Unauthorized' };
  const preview = url.searchParams.get('preview');
  if (preview === null) {
    return { identity: { kind: 'panel', sessionId: session.id, user: session.user } };
  }
  // The panel's live preview: an owner watches an instance without knowing its token.
  if (session.user.role !== 'owner') return { status: 403, reason: 'Forbidden' };
  const instance = options.overlays.get(preview);
  if (!instance) return { status: 404, reason: 'Not Found' };
  return {
    identity: {
      kind: 'overlay',
      instanceId: instance.id,
      pluginId: instance.pluginId,
      overlay: instance.overlay,
      sessionId: session.id,
    },
  };
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
