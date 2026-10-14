import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isInside } from '../fs-paths.ts';
import { errorMessage } from '../names.ts';
import type { DiscoveredPlugin } from './discovery.ts';

/** A bundle folder read into memory at plugin start. Only this copy is ever served. */
export interface BundleSnapshot {
  /** First 16 hex characters of a SHA-256 over the files (paths and contents). */
  readonly hash: string;
  /** File name of the entry inside the folder. */
  readonly entry: string;
  /** Top-level `.css` files, sorted: the bundle's stylesheets. */
  readonly styles: readonly string[];
  /** '/'-separated relative path -> content. Symbolic links are never included. */
  readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  /** Total bytes. */
  readonly size: number;
}

/** A plugin's browser bundles. */
export interface PluginBundles {
  readonly panel?: BundleSnapshot;
  readonly overlays: ReadonlyMap<string, BundleSnapshot>;
  /** Bundles that could not be read; the plugin runs without them. */
  readonly problems: readonly string[];
}

export const MAX_BUNDLE_FILES = 1000;
/** All bundles of one plugin together. Above this the plugin does not start. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

export class BundleTooLargeError extends Error {
  constructor(pluginId: string, maxBytes: number) {
    super(`The browser bundles of "${pluginId}" are larger than ${String(maxBytes)} bytes`);
    this.name = 'BundleTooLargeError';
  }
}

/**
 * Snapshots the panel bundle and every overlay bundle the manifest declares. Throws
 * BundleTooLargeError above `maxBytes` in total; other problems are reported, not thrown.
 */
export async function readPluginBundles(
  plugin: DiscoveredPlugin,
  maxBytes: number = MAX_BUNDLE_BYTES,
): Promise<PluginBundles> {
  const problems: string[] = [];
  let used = 0;
  const read = async (label: string, declared: string): Promise<BundleSnapshot | undefined> => {
    try {
      const snapshot = await readSnapshot(plugin, declared, maxBytes - used, maxBytes);
      used += snapshot.size;
      return snapshot;
    } catch (error) {
      if (error instanceof BundleTooLargeError) throw error;
      problems.push(`${label}: ${errorMessage(error)}`);
      return undefined;
    }
  };
  const { panel: panelEntry, overlays: overlayEntries } = plugin.entries;
  const panel = panelEntry === undefined ? undefined : await read('panel', panelEntry);
  const overlays = new Map<string, BundleSnapshot>();
  for (const name of Object.keys(overlayEntries).sort()) {
    const entry = overlayEntries[name];
    if (entry === undefined) continue;
    const snapshot = await read(`overlay "${name}"`, entry);
    if (snapshot) overlays.set(name, snapshot);
  }
  return { ...(panel ? { panel } : {}), overlays, problems };
}

async function readSnapshot(
  plugin: DiscoveredPlugin,
  declared: string,
  budget: number,
  maxBytes: number,
): Promise<BundleSnapshot> {
  const pluginDir = await realpath(plugin.dir);
  const entryPath = await realpath(resolve(plugin.dir, declared)).catch(() => undefined);
  if (entryPath === undefined) {
    throw new Error(`entry ${declared} does not exist (is the plugin built?)`);
  }
  if (!isInside(pluginDir, entryPath)) {
    throw new Error(`entry ${declared} is outside the plugin folder`);
  }
  const dir = dirname(entryPath);
  if (dir === pluginDir) {
    // Serving the plugin folder itself would hand out its sources, dotfiles and secrets.
    throw new Error(`entry ${declared} must be in a subfolder (e.g. dist/panel/)`);
  }
  const serverPath = await realpath(resolve(plugin.dir, plugin.entries.server)).catch(
    () => undefined,
  );
  if (serverPath !== undefined && isInside(dir, serverPath)) {
    throw new Error(`the folder of ${declared} contains the server entry; build them apart`);
  }
  // Only regular files: links could point anywhere, so they are never part of a snapshot.
  const paths = (await regularFiles(dir))
    .map((path) => relative(dir, path).split(sep).join('/'))
    .sort();
  if (paths.length > MAX_BUNDLE_FILES) {
    throw new Error(`the folder of ${declared} has more than ${String(MAX_BUNDLE_FILES)} files`);
  }
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const hash = createHash('sha256');
  let size = 0;
  for (const path of paths) {
    const data = new Uint8Array(await readFile(join(dir, path)));
    size += data.byteLength;
    if (size > budget) throw new BundleTooLargeError(plugin.id, maxBytes);
    files.set(path, data);
    hash.update(path);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return {
    hash: hash.digest('hex').slice(0, 16),
    entry: basename(entryPath),
    styles: paths.filter((path) => !path.includes('/') && path.endsWith('.css')),
    files,
    size,
  };
}

/**
 * Every regular file below `dir`. A recursive `readdir` would descend into symlinked folders,
 * so the walk only enters real directories.
 */
async function regularFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await regularFiles(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
