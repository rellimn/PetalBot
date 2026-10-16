import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtPluginFolders, watchBuiltPlugins } from '../scripts/plugin-folders.ts';
import { writeBuild } from './helpers.ts';

async function folder(root: string, name: string, pkg: unknown, built: boolean): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (pkg !== undefined) await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  if (built) await writeBuild(dir);
  return dir;
}

describe('builtPluginFolders', () => {
  it('lists plugin folders that were built once, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'petalbot-folders-'));
    const plugin = { name: 'x', version: '1.0.0', petalbot: { id: 'x', apiVersion: 2 } };
    const built = await folder(root, 'built', plugin, true);
    await folder(root, 'installing', plugin, false);
    await folder(root, 'library', { name: 'lib', version: '1.0.0' }, true);
    await folder(root, 'empty', undefined, false);
    await writeFile(join(root, 'README.md'), '');
    expect(builtPluginFolders(root)).toEqual([built]);
  });

  it('answers nothing for a missing root', () => {
    expect(builtPluginFolders(join(tmpdir(), 'petalbot-does-not-exist'))).toEqual([]);
  });
});

describe('watchBuiltPlugins', () => {
  it('starts one watcher per built folder, and a new one after its watcher exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'petalbot-watchers-'));
    const plugin = { name: 'x', version: '1.0.0', petalbot: { id: 'x', apiVersion: 2 } };
    const dir = await folder(root, 'quotes', plugin, true);
    const watching = new Set<string>();
    const started: string[] = [];
    const exits: (() => void)[] = [];
    const start = (folderDir: string, exited: () => void) => {
      started.push(folderDir);
      exits.push(exited);
    };
    watchBuiltPlugins(root, watching, start);
    watchBuiltPlugins(root, watching, start);
    expect(started).toEqual([dir]);
    exits[0]?.();
    watchBuiltPlugins(root, watching, start);
    expect(started).toEqual([dir, dir]);
  });
});
