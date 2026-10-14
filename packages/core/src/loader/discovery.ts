import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../names.ts';
import { readBuildInfo, type PluginEntries } from './build-info.ts';
import { packageSchema, type PluginManifest } from './manifest.ts';

export interface DiscoveredPlugin {
  readonly id: string;
  /** Package version = contract version. */
  readonly version: string;
  readonly dir: string;
  readonly manifest: PluginManifest;
  /** From `dist/build.json`. */
  readonly entries: PluginEntries;
}

export interface DiscoveryProblem {
  readonly dir: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly plugins: ReadonlyMap<string, DiscoveredPlugin>;
  readonly problems: readonly DiscoveryProblem[];
}

/** Reads `<root>/<dir>/package.json` manifests without executing any plugin code. */
export async function discoverPlugins(roots: readonly string[]): Promise<DiscoveryResult> {
  const plugins = new Map<string, DiscoveredPlugin>();
  const problems: DiscoveryProblem[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      names = entries
        // Symlinked folders are common in development; non-folder links simply have no package.json.
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      problems.push({ dir: root, message: `Cannot read plugin directory: ${errorMessage(error)}` });
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      const found = await readPlugin(dir);
      if (found === undefined) continue;
      if ('message' in found) {
        problems.push(found);
        continue;
      }
      const existing = plugins.get(found.id);
      if (existing) {
        problems.push({
          dir,
          message: `Duplicate plugin id "${found.id}" (already found in ${existing.dir})`,
        });
        continue;
      }
      plugins.set(found.id, found);
    }
  }
  return { plugins, problems };
}

async function readPlugin(dir: string): Promise<DiscoveredPlugin | DiscoveryProblem | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    return { dir, message: `Invalid package.json: ${errorMessage(error)}` };
  }
  if (typeof json !== 'object' || json === null || !('petalbot' in json)) return undefined;
  const parsed = packageSchema.safeParse(json);
  if (!parsed.success) {
    return { dir, message: `Invalid PetalBot manifest: ${z.prettifyError(parsed.error)}` };
  }
  const entries = await readBuildInfo(dir);
  if ('message' in entries) return { dir, message: entries.message };
  return {
    id: parsed.data.petalbot.id,
    version: parsed.data.version,
    dir,
    manifest: parsed.data.petalbot,
    entries,
  };
}
