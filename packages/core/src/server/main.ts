import { LogRing } from '../log-ring.ts';
import { createLogger } from '../logger.ts';
import { installProcessGuards } from '../process-guards.ts';
import { loadConfig, type Env } from './config.ts';
import { startHttpServer, type RunningServer } from './server.ts';
import { createServices, type Services } from './services.ts';

export interface StartOptions {
  readonly configPath: string;
  /** Default `process.env`. */
  readonly env?: Env;
  /** Default stdout. */
  readonly logDestination?: { write(line: string): void };
  /** Default true. Tests running in-process pass false. */
  readonly installGuards?: boolean;
}

export interface PetalBot {
  readonly url: string;
  readonly services: Services;
  /** Graceful shutdown. Idempotent. */
  close(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;

/** Config -> database -> kernel -> plugins -> HTTP/WS server */
export async function startPetalBot(options: StartOptions): Promise<PetalBot> {
  const config = await loadConfig(options.configPath, options.env ?? process.env);
  const logs = new LogRing();
  const logger = createLogger({
    level: config.logLevel,
    sink: logs.push,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  });
  if (config.devAuth !== undefined) {
    logger.warn('PETALBOT_DEV_AUTH is set: /auth/login logs anyone in without a password', {
      role: config.devAuth,
    });
  }
  const services = createServices({ config, logger, logs });
  const uninstallGuards =
    options.installGuards === false
      ? () => undefined
      : installProcessGuards({ kernel: services.kernel, logger });
  let server: RunningServer;
  try {
    services.sessions.purgeExpired();
    await services.manager.start();
    services.devReloader?.start();
    server = await startHttpServer({
      services,
      host: config.listen.host,
      port: config.listen.port,
    });
  } catch (error) {
    await services.close();
    uninstallGuards();
    throw error;
  }
  const purge = setInterval(() => {
    services.sessions.purgeExpired();
  }, HOUR);
  purge.unref();
  logger.info('PetalBot listening', { url: server.url, publicUrl: config.publicUrl });

  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    logger.info('PetalBot shutting down');
    clearInterval(purge);
    // 1. stop accepting, 2. close sockets with 1001
    await server.close();
    // 3. stop plugins (dependents first), 4. the event log writes synchronously, 5. close the db
    await services.close();
    uninstallGuards();
  };
  return { url: server.url, services, close: () => (closing ??= shutdown()) };
}
