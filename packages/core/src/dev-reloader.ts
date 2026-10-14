import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@petalbot/sdk';
import { BUILD_MARKER } from './loader/build-info.ts';
import { errorMessage } from './names.ts';
import type { PluginState } from './plugin-manager.ts';

export { BUILD_MARKER } from './loader/build-info.ts';

export interface ReloadablePlugin {
  readonly id: string;
  readonly dir: string;
  readonly state: PluginState;
  readonly enabled: boolean;
}

/** What the reloader needs from the PluginManager. */
export interface ReloadTarget {
  list(): readonly ReloadablePlugin[];
  reload(pluginId: string): Promise<void>;
  enable(pluginId: string): Promise<void>;
  /** Re-reads the plugin folders: a new plugin's first build appeared. */
  rescan(): Promise<void>;
  onChange(listener: (info: ReloadablePlugin) => void): () => void;
  onRemoved(listener: (pluginId: string) => void): () => void;
}

/** Calls `onChange` when `file` is written; returns a function that stops watching. */
export type FileWatch = (file: string, onChange: () => void) => () => void;

/**
 * Polls with `fs.watchFile`: unlike `fs.watch` it works before the file (or its folder) exists
 * and survives the file being replaced. Dev only, so a few stat calls per second are fine.
 */
export const watchByPolling: FileWatch = (file, onChange) => {
  const listener = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs > 0 && current.mtimeMs !== previous.mtimeMs) onChange();
  };
  watchFile(file, { interval: 250, persistent: false }, listener);
  return () => {
    unwatchFile(file, listener);
  };
};

export interface DevReloaderOptions {
  readonly manager: ReloadTarget;
  readonly logger: Logger;
  /** Default: watchByPolling. */
  readonly watch?: FileWatch;
  /** Quiet time after the last marker change. Default 200 ms. */
  readonly debounceMs?: number;
  /** Plugin roots: their new folders are watched for a first build. Default: none. */
  readonly roots?: readonly string[];
  /** Folder names in a root. Default: subfolders and symlinks; none if unreadable. */
  readonly listFolders?: (root: string) => Promise<readonly string[]>;
  /** Default: `fs.access`. */
  readonly exists?: (file: string) => Promise<boolean>;
  /** How often the roots are listed. Default 1000 ms. */
  readonly scanIntervalMs?: number;
}

const listFoldersOf = async (root: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const fileExists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * With `dev: true`: reloads a running plugin when its build marker changes (and restarts an
 * enabled plugin that failed, so fixing a broken plugin needs no click). New folders in the
 * plugin roots are watched too: their first build triggers a rescan, which picks the plugin up.
 */
export class DevReloader {
  readonly #manager: ReloadTarget;
  readonly #logger: Logger;
  readonly #watch: FileWatch;
  readonly #debounceMs: number;
  readonly #watched = new Map<string, { readonly dir: string; readonly stop: () => void }>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Plugins being reloaded now; a marker that lands meanwhile asks for one more round. */
  readonly #inFlight = new Set<string>();
  readonly #pending = new Set<string>();
  #disposers: (() => void)[] = [];
  readonly #roots: readonly string[];
  readonly #listFolders: (root: string) => Promise<readonly string[]>;
  readonly #exists: (file: string) => Promise<boolean>;
  readonly #scanIntervalMs: number;
  /** Folders in the roots that are not (yet) known plugins: dir -> stop watching. */
  readonly #candidates = new Map<string, () => void>();
  #scanTimer: ReturnType<typeof setInterval> | undefined;
  #rescanTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DevReloaderOptions) {
    this.#manager = options.manager;
    this.#logger = options.logger;
    this.#watch = options.watch ?? watchByPolling;
    this.#debounceMs = options.debounceMs ?? 200;
    this.#roots = options.roots ?? [];
    this.#listFolders = options.listFolders ?? listFoldersOf;
    this.#exists = options.exists ?? fileExists;
    this.#scanIntervalMs = options.scanIntervalMs ?? 1000;
  }

  start(): void {
    if (this.#disposers.length > 0) return;
    this.#disposers = [
      this.#manager.onChange((info) => {
        this.#follow(info.id, info.dir);
      }),
      this.#manager.onRemoved((pluginId) => {
        this.#unfollow(pluginId);
      }),
    ];
    for (const info of this.#manager.list()) this.#follow(info.id, info.dir);
    if (this.#roots.length > 0) {
      this.#scanTimer = setInterval(() => {
        void this.#scanRoots();
      }, this.#scanIntervalMs);
      void this.#scanRoots();
    }
  }

  stop(): void {
    clearInterval(this.#scanTimer);
    this.#scanTimer = undefined;
    clearTimeout(this.#rescanTimer);
    for (const stopWatching of this.#candidates.values()) stopWatching();
    this.#candidates.clear();
    for (const dispose of this.#disposers.splice(0)) dispose();
    for (const pluginId of [...this.#watched.keys()]) this.#unfollow(pluginId);
  }

  #follow(pluginId: string, dir: string): void {
    // First: the candidate watches the same file, and stopping it must not stop the new watch.
    this.#candidates.get(dir)?.();
    this.#candidates.delete(dir);
    const current = this.#watched.get(pluginId);
    if (current?.dir === dir) return;
    current?.stop();
    const stop = this.#watch(join(dir, BUILD_MARKER), () => {
      this.#schedule(pluginId);
    });
    this.#watched.set(pluginId, { dir, stop });
  }

  async #scanRoots(): Promise<void> {
    const known = new Set(this.#manager.list().map((info) => info.dir));
    const listed = new Set<string>();
    for (const root of this.#roots) {
      for (const name of await this.#listFolders(root)) {
        if (this.#scanTimer === undefined) return;
        const dir = join(root, name);
        listed.add(dir);
        if (known.has(dir) || this.#candidates.has(dir)) continue;
        const marker = join(dir, BUILD_MARKER);
        this.#candidates.set(
          dir,
          this.#watch(marker, () => {
            this.#scheduleRescan();
          }),
        );
        if (await this.#exists(marker)) this.#scheduleRescan();
      }
    }
    for (const [dir, stopWatching] of this.#candidates) {
      if (listed.has(dir)) continue;
      stopWatching();
      this.#candidates.delete(dir);
    }
  }

  #scheduleRescan(): void {
    clearTimeout(this.#rescanTimer);
    this.#rescanTimer = setTimeout(() => {
      this.#manager.rescan().then(
        () => {
          this.#logger.info('Rescanned plugins after a new build');
        },
        (error: unknown) => {
          this.#logger.warn('Rescanning plugins failed', { error: errorMessage(error) });
        },
      );
    }, this.#debounceMs);
  }

  #unfollow(pluginId: string): void {
    this.#watched.get(pluginId)?.stop();
    this.#watched.delete(pluginId);
    clearTimeout(this.#timers.get(pluginId));
    this.#timers.delete(pluginId);
    this.#pending.delete(pluginId);
  }

  #schedule(pluginId: string): void {
    clearTimeout(this.#timers.get(pluginId));
    this.#timers.set(
      pluginId,
      setTimeout(() => {
        this.#timers.delete(pluginId);
        void this.#reload(pluginId);
      }, this.#debounceMs),
    );
  }

  async #reload(pluginId: string): Promise<void> {
    if (this.#inFlight.has(pluginId)) {
      this.#pending.add(pluginId);
      return;
    }
    const info = this.#manager.list().find((plugin) => plugin.id === pluginId);
    if (!info || !this.#watched.has(pluginId)) return;
    // Mid-transition (starting, stopping, or stopped for a dependency's restart while enabled):
    // try again once it settled instead of dropping the new build.
    if (
      info.state === 'starting' ||
      info.state === 'stopping' ||
      (info.state === 'disabled' && info.enabled)
    ) {
      this.#schedule(pluginId);
      return;
    }
    this.#inFlight.add(pluginId);
    try {
      if (info.state === 'running') {
        await this.#manager.reload(pluginId);
        this.#logger.info('Reloaded a rebuilt plugin', { plugin: pluginId });
      } else if (info.state === 'failed' && info.enabled) {
        await this.#manager.enable(pluginId);
        this.#logger.info('Restarted a rebuilt plugin', { plugin: pluginId });
      }
    } catch (error) {
      this.#logger.warn('Reloading a rebuilt plugin failed', {
        plugin: pluginId,
        error: errorMessage(error),
      });
    } finally {
      this.#inFlight.delete(pluginId);
    }
    if (this.#pending.delete(pluginId)) await this.#reload(pluginId);
  }
}
