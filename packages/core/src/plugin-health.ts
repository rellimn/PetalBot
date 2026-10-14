import { once } from './disposer-scope.ts';

export type FailureSource = 'handler' | 'hook' | 'schedule' | 'route' | 'uncaught';
export type HealthListener = (pluginId: string, degraded: boolean) => void;

export interface PluginHealthOptions {
  /** Failures within `windowMs` that mark a plugin degraded. Default 10. */
  readonly threshold?: number;
  /** Default 60 000 ms. */
  readonly windowMs?: number;
  readonly now?: () => number;
}

/** Tracks failures per plugin. Degraded is a flag only; nothing is disabled automatically. */
export class PluginHealth {
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, number[]>();
  readonly #degraded = new Set<string>();
  readonly #listeners = new Set<HealthListener>();

  constructor(options: PluginHealthOptions = {}) {
    this.#threshold = options.threshold ?? 10;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  record(pluginId: string, source: FailureSource): void {
    if (this.#degraded.has(pluginId)) return;
    if (source === 'uncaught') {
      this.#mark(pluginId);
      return;
    }
    const now = this.#now();
    const recent = (this.#failures.get(pluginId) ?? []).filter((t) => now - t < this.#windowMs);
    recent.push(now);
    this.#failures.set(pluginId, recent);
    if (recent.length >= this.#threshold) this.#mark(pluginId);
  }

  isDegraded(pluginId: string): boolean {
    return this.#degraded.has(pluginId);
  }

  /** Clears failures, e.g. when a plugin (re)starts. */
  reset(pluginId: string): void {
    this.#failures.delete(pluginId);
    if (this.#degraded.delete(pluginId)) this.#notify(pluginId, false);
  }

  onChange(listener: HealthListener): () => void {
    this.#listeners.add(listener);
    return once(() => this.#listeners.delete(listener));
  }

  #mark(pluginId: string): void {
    this.#failures.delete(pluginId);
    this.#degraded.add(pluginId);
    this.#notify(pluginId, true);
  }

  #notify(pluginId: string, degraded: boolean): void {
    for (const listener of this.#listeners) listener(pluginId, degraded);
  }
}
