import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AnyPluginDefinition, PanelUser } from '@petalbot/sdk';
import { resolveConfig, type ResolvedConfig } from '../../src/server/config.ts';
import { SESSION_COOKIE } from '../../src/server/http/cookies.ts';
import { createServices, type Services } from '../../src/server/services.ts';
import { createMemoryLogger, writeBuild } from '../helpers.ts';
import { ownerUser } from './fixtures.ts';

export const ORIGIN = 'http://127.0.0.1:8080';
export const SECRET_KEY = randomBytes(32).toString('base64');

/** Dev mode on loopback with dev auth (owner) unless `env` overrides it. */
export function testConfig(
  raw: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string>> = {},
): ResolvedConfig {
  return resolveConfig(
    { publicUrl: ORIGIN, dev: true, database: ':memory:', pluginDirs: [], ...raw },
    { PETALBOT_SECRET_KEY: SECRET_KEY, PETALBOT_DEV_AUTH: 'owner', ...env },
    process.cwd(),
  );
}

export interface PanelFiles {
  /** Build marker `entries.panel`, relative to the plugin folder. */
  readonly entry: string;
  /** Build marker `entries.overlays`. */
  readonly overlays?: Readonly<Record<string, string>>;
  /** Relative path -> content. */
  readonly files: Readonly<Record<string, string>>;
}

export async function writePlugin(
  root: string,
  id: string,
  dependencies: Readonly<Record<string, string>> = {},
  panel?: PanelFiles,
  overlays: Readonly<Record<string, string>> = {},
): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      petalbot: { id, apiVersion: 2, dependencies },
    }),
  );
  await writeBuild(dir, {
    ...(panel ? { panel: panel.entry } : {}),
    overlays: { ...overlays, ...panel?.overlays },
  });
  for (const [path, content] of Object.entries(panel?.files ?? {})) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/** `name=value` pairs of all Set-Cookie headers. */
export function cookiesOf(response: Response): Record<string, string> {
  return Object.fromEntries(
    response.headers.getSetCookie().map((cookie) => {
      const pair = cookie.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  /** Default: a fresh owner session. */
  readonly as?: PanelUser | 'anonymous';
  /** Default `ORIGIN`; `null` sends no Origin header. */
  readonly origin?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TestServer {
  readonly services: Services;
  readonly root: string;
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** A `Cookie` header value with a new session for `user`. */
  cookieFor(user: PanelUser): string;
  close(): Promise<void>;
}

export interface TestServerOptions {
  readonly definitions?: Readonly<Record<string, AnyPluginDefinition>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly allowInsecureOidc?: boolean;
  readonly panels?: Readonly<Record<string, PanelFiles>>;
  /** Default false: the server tests expect new plugins to start disabled. */
  readonly startNewPlugins?: boolean;
}

/** Real services on an in-memory database; plugins come from `definitions`. */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), 'petalbot-server-'));
  const definitions = options.definitions ?? {};
  for (const [id, definition] of Object.entries(definitions)) {
    const dependencies = Object.fromEntries(
      (definition.dependencies ?? []).map((contract) => [contract.id, `^${contract.version}`]),
    );
    // Every overlay the contract declares gets an entry, so such contracts still load.
    const overlays = Object.fromEntries(
      Object.keys(definition.contract.overlays ?? {}).map((name) => [
        name,
        `dist/overlays/${name}/${name}.js`,
      ]),
    );
    await writePlugin(root, id, dependencies, options.panels?.[id], overlays);
  }
  const services = createServices({
    config: testConfig({ pluginDirs: [root], ...options.config }, options.env),
    logger: createMemoryLogger(),
    load: (plugin) => {
      const definition = definitions[plugin.id];
      return definition
        ? Promise.resolve(definition)
        : Promise.reject(new Error(`no definition for ${plugin.id}`));
    },
    allowInsecureOidc: options.allowInsecureOidc ?? false,
    startNewPlugins: options.startNewPlugins ?? false,
    ...(options.now ? { now: options.now } : {}),
  });
  await services.manager.start();
  const cookieFor = (user: PanelUser) =>
    `${SESSION_COOKIE}=${services.sessions.create(user).token}`;
  return {
    services,
    root,
    cookieFor,
    request(path, request = {}) {
      const headers = new Headers(request.headers);
      const as = request.as ?? ownerUser;
      if (as !== 'anonymous') headers.set('cookie', cookieFor(as));
      const origin = request.origin === undefined ? ORIGIN : request.origin;
      if (origin !== null) headers.set('origin', origin);
      let body: string | undefined = request.rawBody;
      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(request.body);
      }
      return Promise.resolve(
        services.app.request(path, {
          method: request.method ?? 'GET',
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
    },
    close: () => services.close(),
  };
}
