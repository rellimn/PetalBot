import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Role } from '@petalbot/sdk';
import { errorMessage } from '../names.ts';
import { parseSecretKey } from '../storage/secret-store.ts';

/** Where `npx -y pnpm@12.10.1 build` puts the panel. */
const DEFAULT_PANEL_DIR = fileURLToPath(new URL('../../../panel/dist', import.meta.url));
/** Where `npx -y pnpm@12.10.1 build` puts the overlay host. */
const DEFAULT_OVERLAY_DIR = fileURLToPath(new URL('../../../overlay-host/dist', import.meta.url));

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const configSchema = z.object({
  /** Where browsers reach PetalBot, e.g. `https://bot.example.com`. Origin checks compare to it. */
  publicUrl: z.url({ protocol: /^https?$/ }),
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65_535).default(8080),
    })
    .prefault({}),
  /** Any OIDC provider. Optional only with PETALBOT_DEV_AUTH. */
  oidc: z
    .object({
      issuer: z.url(),
      clientId: z.string().min(1),
      scopes: z.array(z.string()).default(['openid', 'profile', 'groups']),
      /** Group name from the `groups` claim -> PetalBot role. Users with no mapped group are rejected. */
      groups: z
        .record(z.string(), z.enum(['owner', 'mod']))
        .refine((mapping) => Object.keys(mapping).length > 0, 'map at least one group to a role'),
      tokenEndpointAuthMethod: z
        .enum(['client_secret_basic', 'client_secret_post'])
        .default('client_secret_basic'),
    })
    .optional(),
  /** SQLite file, relative to the config file. `:memory:` for throwaway instances. */
  database: z.string().default('petalbot.db'),
  /** Folders containing plugin folders, relative to the config file. */
  pluginDirs: z.array(z.string()).default(['plugins']),
  /** The built panel (index.html + assets), relative to the config file. Default: packages/panel/dist. */
  panelDir: z.string().optional(),
  /** The built overlay host, relative to the config file. Default: packages/overlay-host/dist. */
  overlayDir: z.string().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dev: z.boolean().default(false),
  eventLog: z.object({ capacity: z.number().int().min(1).default(1000) }).prefault({}),
});

/** What `petalbot.config.ts` exports; defaulted fields are optional. */
export type PetalBotConfig = z.input<typeof configSchema>;

export type Env = Readonly<Record<string, string | undefined>>;

export type ResolvedConfig = Omit<z.output<typeof configSchema>, 'panelDir' | 'overlayDir'> & {
  readonly panelDir: string;
  readonly overlayDir: string;
  readonly publicOrigin: string;
  readonly secretKey: Buffer;
  readonly oidcClientSecret: string | undefined;
  readonly devAuth: Role | undefined;
};

/** Types `petalbot.config.ts`: `export default defineConfig({ ... })`. */
export function defineConfig(config: PetalBotConfig): PetalBotConfig {
  return config;
}

/** Validates a raw config, applies the env secrets and the security guards. */
export function resolveConfig(raw: unknown, env: Env, baseDir: string): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid PetalBot config:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  const url = new URL(config.publicUrl);
  const loopback = LOOPBACK_HOSTS.has(config.listen.host);
  if (url.protocol !== 'https:' && !(config.dev && loopback)) {
    throw new Error(
      'publicUrl must use https unless dev is true and PetalBot listens on a loopback address',
    );
  }
  const loopbackUrl = LOOPBACK_HOSTS.has(url.hostname.replace(/^\[(.*)\]$/, '$1'));
  const devAuth = parseDevAuth(env.PETALBOT_DEV_AUTH, config.dev, loopback, loopbackUrl);
  if (!config.oidc && devAuth === undefined) {
    throw new Error('oidc is required unless PETALBOT_DEV_AUTH is set');
  }
  const clientSecret = env.PETALBOT_OIDC_CLIENT_SECRET;
  const oidcClientSecret =
    clientSecret === undefined || clientSecret === '' ? undefined : clientSecret;
  if (config.oidc && devAuth === undefined && oidcClientSecret === undefined) {
    throw new Error('PETALBOT_OIDC_CLIENT_SECRET is not set');
  }
  return {
    ...config,
    database: config.database === ':memory:' ? ':memory:' : resolve(baseDir, config.database),
    pluginDirs: config.pluginDirs.map((dir) => resolve(baseDir, dir)),
    panelDir: config.panelDir === undefined ? DEFAULT_PANEL_DIR : resolve(baseDir, config.panelDir),
    overlayDir:
      config.overlayDir === undefined ? DEFAULT_OVERLAY_DIR : resolve(baseDir, config.overlayDir),
    publicOrigin: url.origin,
    secretKey: parseSecretKey(env.PETALBOT_SECRET_KEY),
    oidcClientSecret,
    devAuth,
  };
}

function parseDevAuth(
  value: string | undefined,
  dev: boolean,
  loopback: boolean,
  loopbackUrl: boolean,
): Role | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'owner' && value !== 'mod') {
    throw new Error(`PETALBOT_DEV_AUTH must be "owner" or "mod", got "${value}"`);
  }
  if (!dev) throw new Error('PETALBOT_DEV_AUTH requires dev: true in the config');
  if (!loopback) {
    throw new Error(
      'PETALBOT_DEV_AUTH requires a loopback listen address (127.0.0.1, ::1 or localhost)',
    );
  }
  if (!loopbackUrl) {
    throw new Error(
      'PETALBOT_DEV_AUTH requires a loopback publicUrl (behind a proxy, dev auth would be reachable)',
    );
  }
  return value;
}

/** Imports `petalbot.config.ts` (Node strips the types natively) and resolves it. */
export async function loadConfig(path: string, env: Env = process.env): Promise<ResolvedConfig> {
  const file = resolve(path);
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Cannot load config ${file}: ${errorMessage(error)}`, { cause: error });
  }
  const raw = (module as { default?: unknown }).default;
  if (raw === undefined) throw new Error(`${file} must default-export defineConfig({ ... })`);
  return resolveConfig(raw, env, dirname(file));
}
