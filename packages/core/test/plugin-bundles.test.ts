import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from '../src/loader/discovery.ts';
import { BundleTooLargeError, readPluginBundles } from '../src/loader/bundles.ts';

async function pluginWith(
  files: Record<string, string>,
  entries: { panel?: string; overlays?: Record<string, string>; server?: string } = {},
): Promise<DiscoveredPlugin> {
  const dir = await mkdtemp(join(tmpdir(), 'petalbot-bundle-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return {
    id: 'quotes',
    version: '1.0.0',
    dir,
    manifest: { id: 'quotes', apiVersion: 1, dependencies: {}, optionalDependencies: {} },
    entries: {
      server: entries.server ?? 'dist/server/server.js',
      ...(entries.panel === undefined ? {} : { panel: entries.panel }),
      overlays: entries.overlays ?? {},
    },
  };
}

const text = (data: Uint8Array | undefined): string => new TextDecoder().decode(data);

const files = {
  'dist/server/server.js': 'export default {};',
  'dist/panel/panel.js': 'export default 1;',
  'dist/panel/panel.css': '.a{}',
  'dist/panel/chunks/lazy.js': 'export {}',
  'dist/panel/chunks/lazy.css': '.b{}',
  'dist/overlays/box/box.js': 'export default 2;',
  'dist/overlays/box/box.css': '.c{}',
  'dist/overlays/ticker/ticker.js': 'export default 3;',
};

describe('readPluginBundles', () => {
  it('has nothing for plugins without UI entries', async () => {
    const bundles = await readPluginBundles(await pluginWith({}));
    expect(bundles.panel).toBeUndefined();
    expect(bundles.overlays.size).toBe(0);
    expect(bundles.problems).toEqual([]);
  });

  it('reads the panel and each overlay folder into memory with its own hash', async () => {
    const plugin = await pluginWith(files, {
      panel: 'dist/panel/panel.js',
      overlays: { box: 'dist/overlays/box/box.js', ticker: 'dist/overlays/ticker/ticker.js' },
    });
    const bundles = await readPluginBundles(plugin);
    expect(bundles.panel).toMatchObject({ entry: 'panel.js', styles: ['panel.css'] });
    expect(bundles.panel?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect([...(bundles.panel?.files.keys() ?? [])].sort()).toEqual([
      'chunks/lazy.css',
      'chunks/lazy.js',
      'panel.css',
      'panel.js',
    ]);
    expect(text(bundles.panel?.files.get('chunks/lazy.js'))).toBe('export {}');
    expect(bundles.overlays.get('box')).toMatchObject({ entry: 'box.js', styles: ['box.css'] });
    expect(bundles.overlays.get('ticker')).toMatchObject({ entry: 'ticker.js', styles: [] });
    expect(bundles.overlays.get('box')?.hash).not.toBe(bundles.overlays.get('ticker')?.hash);

    // A snapshot does not follow the disk; a new read sees the change.
    await writeFile(join(plugin.dir, 'dist/overlays/box/box.js'), 'export default 4;');
    expect(text(bundles.overlays.get('box')?.files.get('box.js'))).toBe('export default 2;');
    const again = await readPluginBundles(plugin);
    expect(again.overlays.get('box')?.hash).not.toBe(bundles.overlays.get('box')?.hash);
    expect(again.panel?.hash).toBe(bundles.panel?.hash);
  });

  it('reports unusable entries as problems instead of failing', async () => {
    const outside = await pluginWith({ 'x.js': '' });
    const plugin = await pluginWith(
      { 'panel.js': 'export default 1;', '.env': 'SECRET=1', 'dist/server/server.js': '' },
      {
        panel: 'panel.js',
        overlays: {
          missing: 'dist/overlays/missing/missing.js',
          away: join('..', outside.dir.split('/').at(-1) ?? '', 'x.js'),
          server: 'dist/server/server.js',
        },
      },
    );
    const bundles = await readPluginBundles(plugin);
    expect(bundles.panel).toBeUndefined();
    expect(bundles.overlays.size).toBe(0);
    expect(bundles.problems).toEqual([
      expect.stringMatching(/^panel: .*must be in a subfolder/) as string,
      expect.stringMatching(/^overlay "away": .*outside the plugin folder/) as string,
      expect.stringMatching(/^overlay "missing": .*does not exist/) as string,
      expect.stringMatching(/^overlay "server": .*contains the server entry/) as string,
    ]);
  });

  it('never follows symbolic links out of a bundle folder', async () => {
    const secret = await pluginWith({ 'secret.txt': 'SECRET' });
    const plugin = await pluginWith(files, { panel: 'dist/panel/panel.js' });
    await symlink(join(secret.dir, 'secret.txt'), join(plugin.dir, 'dist/panel/leak.txt'));
    await symlink(secret.dir, join(plugin.dir, 'dist/panel/leakdir'));
    const bundles = await readPluginBundles(plugin);
    const names = [...(bundles.panel?.files.keys() ?? [])];
    expect(names.some((name) => name.startsWith('leak'))).toBe(false);
  });

  it('refuses bundles that are larger than the cap in total', async () => {
    const plugin = await pluginWith(
      { 'dist/panel/panel.js': 'x'.repeat(600), 'dist/overlays/box/box.js': 'y'.repeat(600) },
      { panel: 'dist/panel/panel.js', overlays: { box: 'dist/overlays/box/box.js' } },
    );
    await expect(readPluginBundles(plugin, 1000)).rejects.toThrow(BundleTooLargeError);
    await expect(readPluginBundles(plugin, 1000)).rejects.toThrow('larger than 1000 bytes');
    expect((await readPluginBundles(plugin, 2000)).overlays.size).toBe(1);
  });
});
