import { once } from 'node:events';
import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { CLOSE } from './gateway/protocol.ts';
import type { Services } from './services.ts';
import { attachWebSocketServer } from './ws-server.ts';

export interface StartServerOptions {
  readonly services: Services;
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly heartbeatMs?: number;
}

export interface RunningServer {
  /** The address actually listened on, e.g. `http://127.0.0.1:8080`. */
  readonly url: string;
  /** Closes WebSockets with 1001, then stops the HTTP server. Idempotent. */
  close(): Promise<void>;
}

export async function startHttpServer(options: StartServerOptions): Promise<RunningServer> {
  const { services } = options;
  const server = serve({ fetch: services.app.fetch, hostname: options.host, port: options.port });
  if (!(server instanceof Server)) throw new Error('Expected a plain HTTP/1.1 server');
  await once(server, 'listening');
  const ws = attachWebSocketServer({
    server,
    gateway: services.gateway,
    sessions: services.sessions,
    overlays: services.overlays,
    publicOrigin: services.config.publicOrigin,
    logger: services.logger,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    await ws.close(CLOSE.serverShutdown, 'Server shutting down');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  };
  return { url: `http://${host}:${String(address.port)}`, close: () => (closing ??= close()) };
}
