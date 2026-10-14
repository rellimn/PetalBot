import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Folders in `root` that hold a plugin which was built at least once: a package.json with a
 * "petalbot" field and dist/build.json. `pnpm create-plugin` installs and builds before the
 * marker exists, so a folder that is still being scaffolded is never listed. Sorted.
 */
export function builtPluginFolders(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, 'dist', 'build.json')) && isPlugin(dir));
}

function isPlugin(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
    return typeof pkg === 'object' && pkg !== null && 'petalbot' in pkg;
  } catch {
    return false;
  }
}

/**
 * Starts a watcher for every built plugin folder in `root` that has none (`watching`). When a
 * watcher exits (its folder was deleted, say), `exited` frees the folder, so a re-created plugin
 * gets a new watcher on a later call.
 */
export function watchBuiltPlugins(
  root: string,
  watching: Set<string>,
  start: (dir: string, exited: () => void) => void,
): void {
  for (const dir of builtPluginFolders(root)) {
    if (watching.has(dir)) continue;
    watching.add(dir);
    start(dir, () => {
      watching.delete(dir);
    });
  }
}
