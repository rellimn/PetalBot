import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineConfig, loadConfig, resolveConfig } from '../../src/server/config.ts';

const KEY = randomBytes(32).toString('base64');
const env = { PETALBOT_SECRET_KEY: KEY, PETALBOT_OIDC_CLIENT_SECRET: 'client-secret' };
const oidc = {
  issuer: 'https://auth.example.com',
  clientId: 'petalbot',
  groups: { 'petalbot-owners': 'owner' },
};
const base = { publicUrl: 'https://bot.example.com', oidc };

describe('resolveConfig', () => {
  it('defaults panelDir to the panel package build and resolves custom ones', () => {
    const base = { publicUrl: 'http://127.0.0.1:8080', dev: true };
    const env = {
      PETALBOT_SECRET_KEY: Buffer.alloc(32).toString('base64'),
      PETALBOT_DEV_AUTH: 'owner',
    };
    expect(resolveConfig(base, env, '/srv/bot').panelDir).toMatch(/packages[/\\]panel[/\\]dist$/);
    expect(resolveConfig({ ...base, panelDir: 'web' }, env, '/srv/bot').panelDir).toBe(
      '/srv/bot/web',
    );
  });

  it('fills defaults and resolves paths against the config directory', () => {
    const config = resolveConfig(base, env, '/srv/petalbot');
    expect(config).toMatchObject({
      publicOrigin: 'https://bot.example.com',
      listen: { host: '127.0.0.1', port: 8080 },
      database: '/srv/petalbot/petalbot.db',
      pluginDirs: ['/srv/petalbot/plugins'],
      logLevel: 'info',
      dev: false,
      eventLog: { capacity: 1000 },
      oidc: {
        scopes: ['openid', 'profile', 'groups'],
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      oidcClientSecret: 'client-secret',
      devAuth: undefined,
    });
    expect(config.secretKey).toHaveLength(32);
  });

  it('keeps an in-memory database as is', () => {
    expect(resolveConfig({ ...base, database: ':memory:' }, env, '/x').database).toBe(':memory:');
  });

  it('explains invalid configs', () => {
    expect(() => resolveConfig({ oidc }, env, '/')).toThrow(
      /Invalid PetalBot config[\s\S]*publicUrl/,
    );
  });

  it('requires https unless in dev mode on a loopback address', () => {
    expect(() => resolveConfig({ ...base, publicUrl: 'http://bot.example.com' }, env, '/')).toThrow(
      'publicUrl must use https',
    );
    const exposedDev = {
      ...base,
      publicUrl: 'http://127.0.0.1:8080',
      dev: true,
      listen: { host: '0.0.0.0' },
    };
    expect(() => resolveConfig(exposedDev, env, '/')).toThrow('publicUrl must use https');
    const localDev = { ...base, publicUrl: 'http://127.0.0.1:8080', dev: true };
    expect(resolveConfig(localDev, env, '/').publicOrigin).toBe('http://127.0.0.1:8080');
  });

  it('requires a group mapping, the client secret and the secret key', () => {
    expect(() => resolveConfig({ ...base, oidc: { ...oidc, groups: {} } }, env, '/')).toThrow(
      'map at least one group to a role',
    );
    expect(() => resolveConfig(base, { PETALBOT_SECRET_KEY: KEY }, '/')).toThrow(
      'PETALBOT_OIDC_CLIENT_SECRET is not set',
    );
    expect(() => resolveConfig(base, { PETALBOT_OIDC_CLIENT_SECRET: 'x' }, '/')).toThrow(
      'PETALBOT_SECRET_KEY is not set',
    );
  });
});

describe('dev auth', () => {
  const dev = { publicUrl: 'http://127.0.0.1:8080', dev: true };

  it('logs in without a provider when dev mode runs on loopback', () => {
    const config = resolveConfig(dev, { PETALBOT_SECRET_KEY: KEY, PETALBOT_DEV_AUTH: 'mod' }, '/');
    expect(config.devAuth).toBe('mod');
    expect(config.oidc).toBeUndefined();
  });

  it.each([
    [{ ...dev, dev: false, publicUrl: 'https://bot.example.com' }, 'requires dev: true'],
    [
      { ...dev, publicUrl: 'https://bot.example.com', listen: { host: '0.0.0.0' } },
      'requires a loopback listen address',
    ],
    [
      { ...dev, publicUrl: 'https://bot.example.com' },
      'requires a loopback publicUrl (behind a proxy, dev auth would be reachable)',
    ],
  ])('refuses to start when a guard fails (%#)', (raw, message) => {
    expect(() =>
      resolveConfig(raw, { PETALBOT_SECRET_KEY: KEY, PETALBOT_DEV_AUTH: 'owner' }, '/'),
    ).toThrow(message);
  });

  it('rejects unknown roles', () => {
    expect(() =>
      resolveConfig(dev, { PETALBOT_SECRET_KEY: KEY, PETALBOT_DEV_AUTH: 'admin' }, '/'),
    ).toThrow('PETALBOT_DEV_AUTH must be "owner" or "mod"');
  });

  it('requires oidc without dev auth', () => {
    expect(() => resolveConfig(dev, { PETALBOT_SECRET_KEY: KEY }, '/')).toThrow(
      'oidc is required unless PETALBOT_DEV_AUTH is set',
    );
  });
});

describe('loadConfig', () => {
  async function configFile(source: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'petalbot-config-'));
    const file = join(dir, 'petalbot.config.ts');
    await writeFile(file, source);
    return file;
  }

  it('imports a TypeScript config file and resolves paths next to it', async () => {
    const file = await configFile(
      `const url: string = 'https://bot.example.com';\n` +
        `export default { publicUrl: url, oidc: ${JSON.stringify(oidc)}, database: 'data/bot.db' };\n`,
    );
    const config = await loadConfig(file, env);
    expect(config.database).toBe(join(file, '..', 'data', 'bot.db'));
  });

  it('requires a default export', async () => {
    const file = await configFile('export const nothing = 1;\n');
    await expect(loadConfig(file, env)).rejects.toThrow('must default-export defineConfig');
  });

  it('reports files that cannot be imported', async () => {
    await expect(loadConfig('/nonexistent/petalbot.config.ts', env)).rejects.toThrow(
      'Cannot load config /nonexistent/petalbot.config.ts',
    );
  });

  it('types the config file through defineConfig', () => {
    const raw = defineConfig({ publicUrl: 'https://bot.example.com', dev: false });
    expect(raw.publicUrl).toBe('https://bot.example.com');
  });
});
