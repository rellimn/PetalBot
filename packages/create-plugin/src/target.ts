import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function manifestId(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      petalbot?: { id?: unknown };
    };
    return typeof pkg.petalbot?.id === 'string' ? pkg.petalbot.id : undefined;
  } catch {
    return undefined;
  }
}

/** The new plugin's folder. Throws when it exists or another plugin folder uses the id. */
export function checkTarget(pluginsDir: string, id: string): string {
  const dir = join(pluginsDir, id);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const other = join(pluginsDir, entry.name);
    if (manifestId(other) === id) {
      throw new Error(`The plugin id "${id}" is already used by ${other}`);
    }
  }
  return dir;
}
