import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverPlugins } from '../src/index.ts';
import { writeBuild } from './helpers.ts';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'petalbot-plugins-'));
}

async function writePackage(
  dir: string,
  name: string,
  content: unknown,
  build: Parameters<typeof writeBuild>[1] | null = { server: 'dist/server.js' },
): Promise<string> {
  const pluginDir = join(dir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, 'package.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  if (build) await writeBuild(pluginDir, build);
  return pluginDir;
}

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  name: `@petalbot-plugin/${id}`,
  version: '1.2.3',
  petalbot: { id, apiVersion: 3, ...extra },
});

describe('discoverPlugins', () => {
  it('finds plugins and ignores everything that is not one', async () => {
    const dir = await root();
    const quotesDir = await writePackage(dir, 'quotes', manifest('quotes'));
    await writePackage(dir, 'some-lib', { name: 'some-lib', version: '1.0.0' });
    await mkdir(join(dir, 'empty-folder'));
    await writeFile(join(dir, 'README.md'), 'not a plugin');

    const result = await discoverPlugins([dir]);
    expect(result.problems).toEqual([]);
    expect([...result.plugins.keys()]).toEqual(['quotes']);
    expect(result.plugins.get('quotes')).toEqual({
      id: 'quotes',
      version: '1.2.3',
      dir: quotesDir,
      manifest: { id: 'quotes', apiVersion: 3, dependencies: {}, optionalDependencies: {} },
      entries: { server: 'dist/server.js', overlays: {} },
    });
  });

  it('accepts API 3 and rejects API 2 explicitly', async () => {
    const dir = await root();
    const legacy = await writePackage(dir, 'legacy', manifest('legacy', { apiVersion: 2 }));
    await writePackage(dir, 'current', manifest('current', { apiVersion: 3 }));
    const result = await discoverPlugins([dir]);
    expect([...result.plugins.keys()]).toEqual(['current']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.dir).toBe(legacy);
    expect(result.problems[0]?.message).toMatch(/is not supported.*supported: 3/);
  });

  it('reports broken manifests without losing valid plugins', async () => {
    const dir = await root();
    await writePackage(dir, 'good', manifest('good'));
    const brokenJson = await writePackage(dir, 'broken-json', '{ not json');
    const badId = await writePackage(dir, 'bad-id', manifest('Bad_Id'));
    const badApi = await writePackage(dir, 'bad-api', manifest('bad-api', { apiVersion: 99 }));
    const badRange = await writePackage(
      dir,
      'bad-range',
      manifest('bad-range', { dependencies: { good: 'not a range' } }),
    );
    const reserved = await writePackage(dir, 'core', manifest('core'));

    const result = await discoverPlugins([dir]);
    expect([...result.plugins.keys()]).toEqual(['good']);
    const byDir = new Map(result.problems.map((p) => [p.dir, p.message]));
    expect(byDir.get(brokenJson)).toMatch(/Invalid package.json/);
    expect(byDir.get(badId)).toMatch(/must match/);
    expect(byDir.get(badApi)).toMatch(/is not supported/);
    expect(byDir.get(badRange)).toMatch(/must be a semver range/);
    expect(byDir.get(reserved)).toMatch(/is reserved/);
  });

  it('reports duplicate ids and keeps the first one', async () => {
    const first = await root();
    const second = await root();
    const kept = await writePackage(first, 'quotes', manifest('quotes'));
    const duplicate = await writePackage(second, 'quotes-copy', manifest('quotes'));
    const result = await discoverPlugins([first, second]);
    expect(result.plugins.get('quotes')?.dir).toBe(kept);
    expect(result.problems).toEqual([
      { dir: duplicate, message: `Duplicate plugin id "quotes" (already found in ${kept})` },
    ]);
  });

  it('reports unreadable roots', async () => {
    const missing = join(await root(), 'does-not-exist');
    const result = await discoverPlugins([missing]);
    expect(result.problems[0]?.dir).toBe(missing);
    expect(result.problems[0]?.message).toMatch(/Cannot read plugin directory/);
  });

  it('follows symlinked plugin folders', async () => {
    const dir = await root();
    const elsewhere = await root();
    const real = await writePackage(elsewhere, 'quotes', manifest('quotes'));
    await symlink(real, join(dir, 'quotes'));
    const result = await discoverPlugins([dir]);
    expect(result.problems).toEqual([]);
    expect(result.plugins.get('quotes')?.dir).toBe(join(dir, 'quotes'));
  });

  it('reads the entries from the build marker', async () => {
    const dir = await root();
    await writePackage(dir, 'quotes', manifest('quotes'), {
      server: 'dist/server/server.js',
      panel: 'dist/panel/panel.js',
      overlays: { box: 'dist/overlays/box/box.js' },
    });
    const result = await discoverPlugins([dir]);
    expect(result.plugins.get('quotes')?.entries).toEqual({
      server: 'dist/server/server.js',
      panel: 'dist/panel/panel.js',
      overlays: { box: 'dist/overlays/box/box.js' },
    });
  });

  it('reports plugins that are not built, or built by an older tooling', async () => {
    const dir = await root();
    const unbuilt = await writePackage(dir, 'unbuilt', manifest('unbuilt'), null);
    const old = await writePackage(dir, 'old', manifest('old'), null);
    await mkdir(join(old, 'dist'));
    await writeFile(join(old, 'dist', 'build.json'), JSON.stringify({ builtAt: 1 }));
    const noServer = await writePackage(dir, 'no-server', manifest('no-server'), null);
    await mkdir(join(noServer, 'dist'));
    await writeFile(
      join(noServer, 'dist', 'build.json'),
      JSON.stringify({ builtAt: 1, entries: { overlays: {} } }),
    );
    const result = await discoverPlugins([dir]);
    expect([...result.plugins.keys()]).toEqual([]);
    const byDir = new Map(result.problems.map((p) => [p.dir, p.message]));
    expect(byDir.get(unbuilt)).toMatch(/^Not built: dist\/build.json is missing/);
    expect(byDir.get(old)).toMatch(/^Not built: dist\/build.json is invalid .*rebuild/s);
    expect(byDir.get(noServer)).toMatch(/^Not built: dist\/build.json names no server entry/);
  });

  it('refuses entries outside the plugin folder', async () => {
    const dir = await root();
    const escaping = await writePackage(dir, 'escaping', manifest('escaping'), {
      server: '../elsewhere/server.js',
    });
    const result = await discoverPlugins([dir]);
    expect(result.problems).toEqual([
      {
        dir: escaping,
        message: 'dist/build.json: the entry ../elsewhere/server.js is outside the plugin folder',
      },
    ]);
  });

  it('tells authors to remove entries from package.json', async () => {
    const dir = await root();
    const legacy = await writePackage(
      dir,
      'legacy',
      manifest('legacy', { entries: { server: 'dist/server.js' } }),
    );
    const result = await discoverPlugins([dir]);
    expect(result.problems[0]?.dir).toBe(legacy);
    expect(result.problems[0]?.message).toMatch(/entries.*no longer used/s);
  });
});
