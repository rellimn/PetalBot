import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@petalbot/sdk';
import { errorMessage } from './names.ts';
import type { PluginState } from './plugin-manager.ts';

/** Written by `petalbotPlugin()` after every complete build (same path as @petalbot/tooling's). */
export const BUILD_MARKER = join('dist', 'build.json');

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
}

/**
 * With `dev: true`: reloads a running plugin when its build marker changes (and restarts an
 * enabled plugin that failed, so fixing a broken plugin needs no click).
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

  constructor(options: DevReloaderOptions) {
    this.#manager = options.manager;
    this.#logger = options.logger;
    this.#watch = options.watch ?? watchByPolling;
    this.#debounceMs = options.debounceMs ?? 200;
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
  }

  stop(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
    for (const pluginId of [...this.#watched.keys()]) this.#unfollow(pluginId);
  }

  #follow(pluginId: string, dir: string): void {
    const current = this.#watched.get(pluginId);
    if (current?.dir === dir) return;
    current?.stop();
    const stop = this.#watch(join(dir, BUILD_MARKER), () => {
      this.#schedule(pluginId);
    });
    this.#watched.set(pluginId, { dir, stop });
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
