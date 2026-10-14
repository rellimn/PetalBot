import { DevReloader } from '../dev-reloader.ts';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AnyPluginDefinition, Logger } from '@petalbot/sdk';
import { Kernel } from '../kernel.ts';
import { LogRing } from '../log-ring.ts';
import type { DiscoveredPlugin } from '../loader/discovery.ts';
import { PluginManager } from '../plugin-manager.ts';
import { openDatabase, type Sqlite } from '../storage/database.ts';
import { createStorage } from '../storage/storage.ts';
import { createApp, type AppEnv } from './app.ts';
import { OidcClient } from './auth/oidc.ts';
import { PendingLogins } from './auth/pending-logins.ts';
import { SessionStore } from './auth/session-store.ts';
import type { ResolvedConfig } from './config.ts';
import { EventLog } from './event-log.ts';
import { ClientGateway } from './gateway/gateway.ts';
import { CLOSE } from './gateway/protocol.ts';
import { OverlayInstanceStore } from './overlays/instance-store.ts';
import { UserStore } from './users/user-store.ts';

export interface ServicesOptions {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  /** Replaces importing plugin server entries (tests). */
  readonly load?: (plugin: DiscoveredPlugin) => Promise<AnyPluginDefinition>;
  /** Allow an http:// OIDC issuer (tests). */
  readonly allowInsecureOidc?: boolean;
  readonly now?: () => number;
  /** The ring the logger's sink writes to. Default: an empty ring. */
  readonly logs?: LogRing;
  /** Enable plugins seen for the first time. Default: `config.dev`. */
  readonly startNewPlugins?: boolean;
}

export interface Services {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly sqlite: Sqlite;
  readonly kernel: Kernel;
  readonly manager: PluginManager;
  readonly sessions: SessionStore;
  readonly overlays: OverlayInstanceStore;
  readonly users: UserStore;
  readonly eventLog: EventLog;
  readonly logs: LogRing;
  readonly gateway: ClientGateway;
  readonly oidc: OidcClient | undefined;
  readonly app: OpenAPIHono<AppEnv>;
  /** Set with `dev: true`; startPetalBot starts it. */
  readonly devReloader: DevReloader | undefined;
  /** Stops all plugins, detaches every listener and closes the database. Idempotent. */
  close(): Promise<void>;
}

/** Wires storage, kernel, plugins, stores, gateway and HTTP app. Starts nothing. */
export function createServices(options: ServicesOptions): Services {
  const { config, logger } = options;
  const clock = options.now ? { now: options.now } : {};
  const sqlite = openDatabase(config.database);
  const kernel = new Kernel({
    logger,
    storage: createStorage(sqlite, config.secretKey),
    publicUrl: config.publicUrl,
  });
  const manager = new PluginManager({
    kernel,
    sqlite,
    roots: config.pluginDirs,
    logger,
    startNewPlugins: options.startNewPlugins ?? config.dev,
    ...(options.load ? { load: options.load } : {}),
  });
  const devReloader = config.dev
    ? new DevReloader({ manager, logger, roots: config.pluginDirs })
    : undefined;
  const sessions = new SessionStore(sqlite, clock);
  const overlays = new OverlayInstanceStore(sqlite, clock);
  const users = new UserStore(sqlite, clock);
  const eventLog = new EventLog(sqlite, { capacity: config.eventLog.capacity });
  const logs = options.logs ?? new LogRing();
  const gateway = new ClientGateway({ kernel, plugins: manager, overlays, logger, logs });
  const oidc = createOidc(config, options.allowInsecureOidc === true);
  const disposers = [
    kernel.tap((event) => {
      eventLog.record(event);
    }),
    sessions.onRevoke((id) => {
      gateway.closeWhere(
        (identity) => identity.sessionId === id,
        CLOSE.sessionEnded,
        'Session ended',
      );
    }),
    overlays.onRevoke((id, reason) => {
      gateway.closeWhere(
        (identity) =>
          identity.kind === 'overlay' &&
          identity.instanceId === id &&
          // Previews run on the owner's session, not on the token: rotating keeps them open.
          (reason === 'revoked' || identity.sessionId === undefined),
        CLOSE.overlayRevoked,
        reason === 'revoked' ? 'Overlay revoked' : 'Overlay token rotated',
      );
    }),
  ];
  const app = createApp({
    config,
    logger,
    kernel,
    manager,
    sessions,
    overlays,
    users,
    eventLog,
    logs,
    pendingLogins: new PendingLogins(clock),
    oidc,
  });

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    devReloader?.stop();
    await manager.stopAll();
    manager.dispose();
    gateway.dispose();
    for (const dispose of disposers) dispose();
    sqlite.close();
  };
  return {
    config,
    logger,
    sqlite,
    kernel,
    manager,
    sessions,
    overlays,
    users,
    eventLog,
    logs,
    gateway,
    oidc,
    app,
    devReloader,
    close: () => (closing ??= close()),
  };
}

function createOidc(config: ResolvedConfig, allowInsecure: boolean): OidcClient | undefined {
  if (!config.oidc || config.devAuth !== undefined) return undefined;
  if (config.oidcClientSecret === undefined)
    throw new Error('PETALBOT_OIDC_CLIENT_SECRET is not set');
  return new OidcClient({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidcClientSecret,
    tokenEndpointAuthMethod: config.oidc.tokenEndpointAuthMethod,
    scopes: config.oidc.scopes,
    redirectUri: new URL('/auth/callback', config.publicUrl).href,
    allowInsecureRequests: allowInsecure,
  });
}
