import type { z } from 'zod';
import type { AnyPluginDefinition, ContractShape, Logger } from '@petalbot/sdk';
import { once } from './disposer-scope.ts';
import type { Kernel } from './kernel.ts';
import {
  discoverPlugins,
  type DiscoveredPlugin,
  type DiscoveryProblem,
} from './loader/discovery.ts';
import { resolveGraph, type GraphNode } from './loader/graph.ts';
import { readBuildInfo } from './loader/build-info.ts';
import { loadDefinition } from './loader/load-definition.ts';
import { readPluginBundles, type BundleSnapshot, type PluginBundles } from './loader/bundles.ts';
import { errorMessage } from './names.ts';
import { runInPlugin } from './plugin-scope.ts';
import { hasUserSecrets, type SecretStatus } from './plugin-secrets.ts';
import type { Sqlite } from './storage/database.ts';
import { PluginStateStore } from './storage/plugin-state-store.ts';

export type PluginState = 'disabled' | 'starting' | 'running' | 'stopping' | 'failed';

/** URLs of a running plugin's panel bundle. */
export interface PanelBundleInfo {
  readonly entry: string;
  readonly styles: readonly string[];
}

/** URLs of a running plugin's overlay bundle. */
export interface OverlayBundleInfo {
  readonly hash: string;
  readonly entry: string;
  readonly styles: readonly string[];
}

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  readonly dir: string;
  readonly state: PluginState;
  readonly enabled: boolean;
  readonly degraded: boolean;
  readonly error?: string;
  readonly dependencies: readonly string[];
  readonly optionalDependencies: readonly string[];
  /** The build has a panel entry. */
  readonly hasPanel: boolean;
  /** Settings or user-settable secrets. Known once the core has loaded the plugin's definition. */
  readonly hasSettings?: boolean;
  /** The panel bundle, while the plugin runs and its bundle could be read. */
  readonly panel?: PanelBundleInfo;
}

/** The action needs the user's confirmation because it affects other plugins. */
export class DependencyActionRequired extends Error {
  readonly plugins: readonly string[];

  constructor(message: string, plugins: readonly string[]) {
    super(message);
    this.name = 'DependencyActionRequired';
    this.plugins = plugins;
  }
}

export interface PluginManagerOptions {
  readonly kernel: Kernel;
  readonly sqlite: Sqlite;
  readonly roots: readonly string[];
  readonly logger: Logger;
  /** Loads a plugin's definition; defaults to importing its server entry. */
  readonly load?: (plugin: DiscoveredPlugin) => Promise<AnyPluginDefinition>;
  /** Cap for all browser bundles of one plugin. Default 20 MiB. */
  readonly maxBundleBytes?: number;
  /**
   * Dev: a plugin with no stored enabled/disabled choice is enabled when discovered (on start and
   * on rescans). Default false: new plugins start disabled.
   */
  readonly startNewPlugins?: boolean;
}

interface Status {
  readonly state: PluginState;
  readonly error?: string;
  /** Where a failure came from: the dependency graph (cleared by a rescan) or a start attempt. */
  readonly source?: 'graph' | 'runtime';
}

/** Owns plugin state transitions. Every mutating operation runs alone, in call order. */
export class PluginManager {
  readonly #kernel: Kernel;
  readonly #roots: readonly string[];
  readonly #logger: Logger;
  readonly #load: (plugin: DiscoveredPlugin) => Promise<AnyPluginDefinition>;
  readonly #store: PluginStateStore;
  readonly #status = new Map<string, Status>();
  readonly #definitions = new Map<string, AnyPluginDefinition>();
  readonly #bundles = new Map<string, PluginBundles>();
  readonly #maxBundleBytes: number | undefined;
  readonly #startNewPlugins: boolean;
  readonly #listeners = new Set<(info: PluginInfo) => void>();
  #plugins = new Map<string, DiscoveredPlugin>();
  #problems = new Map<string, string>();
  #discoveryProblems: readonly DiscoveryProblem[] = [];
  #order: readonly string[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  readonly #removedListeners = new Set<(pluginId: string) => void>();
  readonly #unsubscribeHealth: () => void;

  constructor(options: PluginManagerOptions) {
    this.#kernel = options.kernel;
    this.#roots = options.roots;
    this.#logger = options.logger;
    this.#load = options.load ?? loadDefinition;
    this.#store = new PluginStateStore(options.sqlite);
    this.#maxBundleBytes = options.maxBundleBytes;
    this.#startNewPlugins = options.startNewPlugins ?? false;
    this.#unsubscribeHealth = options.kernel.onHealthChange((pluginId) => {
      this.#notify(pluginId);
    });
  }

  /** Discovers plugins and starts every enabled one, dependencies first. */
  start(): Promise<void> {
    return this.#serialize(async () => {
      await this.#scan();
      for (const id of this.#order) {
        if (this.#store.isEnabled(id)) await this.#startOne(id);
      }
    });
  }

  /**
   * Re-reads manifests. Running plugins keep their loaded code until reloaded. Plugins that
   * (re)appear start when they are enabled; with `startNewPlugins`, plugins seen for the first
   * time are enabled.
   */
  rescan(): Promise<void> {
    return this.#serialize(async () => {
      const appeared = await this.#scan();
      for (const id of this.#order) {
        if (appeared.includes(id) && this.#store.isEnabled(id)) await this.#startOne(id);
      }
    });
  }

  list(): PluginInfo[] {
    return [...this.#plugins.keys()].sort().map((id) => this.#info(id));
  }

  get(pluginId: string): PluginInfo {
    this.#require(pluginId);
    return this.#info(pluginId);
  }

  /** The panel bundle of a running plugin. */
  panelSnapshot(pluginId: string): BundleSnapshot | undefined {
    return this.#bundles.get(pluginId)?.panel;
  }

  /** An overlay bundle of a running plugin. */
  overlaySnapshot(pluginId: string, overlay: string): BundleSnapshot | undefined {
    return this.#bundles.get(pluginId)?.overlays.get(overlay);
  }

  /** URLs of an overlay bundle of a running plugin. */
  overlayBundle(pluginId: string, overlay: string): OverlayBundleInfo | undefined {
    const snapshot = this.overlaySnapshot(pluginId, overlay);
    if (!snapshot) return undefined;
    const base = `/plugins/${pluginId}/overlays/${encodeURIComponent(overlay)}/${snapshot.hash}/`;
    return {
      hash: snapshot.hash,
      entry: base + encodeURIComponent(snapshot.entry),
      styles: snapshot.styles.map((style) => base + encodeURIComponent(style)),
    };
  }

  /** Folders that could not be read as plugins (shown in the panel). */
  discoveryProblems(): readonly DiscoveryProblem[] {
    return this.#discoveryProblems;
  }

  onChange(listener: (info: PluginInfo) => void): () => void {
    this.#listeners.add(listener);
    return once(() => this.#listeners.delete(listener));
  }

  /** Called with the id of a plugin whose folder disappeared (after a rescan). */
  onRemoved(listener: (pluginId: string) => void): () => void {
    this.#removedListeners.add(listener);
    return once(() => this.#removedListeners.delete(listener));
  }

  /** Stops every running plugin, dependents first. Enabled flags stay for the next start. */
  stopAll(): Promise<void> {
    return this.#serialize(async () => {
      const ordered = [
        ...this.#order,
        ...[...this.#plugins.keys()].filter((id) => !this.#order.includes(id)),
      ];
      for (const id of ordered.reverse()) {
        if (this.#kernel.isRunning(id)) await this.#stopOne(id);
      }
    });
  }

  /** Detaches from the kernel. Call after `stopAll()` when shutting down. */
  dispose(): void {
    this.#unsubscribeHealth();
    this.#listeners.clear();
    this.#removedListeners.clear();
  }

  /** The contract of a plugin whose definition is loaded (running, or read for its settings). */
  cachedContract(pluginId: string): ContractShape | undefined {
    return this.#definitions.get(pluginId)?.contract;
  }

  /** Stored settings (parsed) and the settings schema; loads the definition if not running. */
  settings(
    pluginId: string,
  ): Promise<{ readonly values: unknown; readonly schema: z.ZodObject | undefined }> {
    return this.#serialize(async () => {
      const plugin = this.#require(pluginId);
      const definition = await this.#definition(pluginId, plugin);
      return {
        values: this.#kernel.readSettings(definition),
        schema: definition.contract.settings,
      };
    });
  }

  /** The user-settable secrets (never their values); loads the definition if not running. */
  secrets(pluginId: string): Promise<SecretStatus[]> {
    return this.#serialize(async () => {
      const definition = await this.#definition(pluginId, this.#require(pluginId));
      return this.#kernel.secrets(definition).status();
    });
  }

  /** A panel write. `undefined` when the plugin declares no user-settable secret `name`. */
  setSecret(pluginId: string, name: string, value: string): Promise<SecretStatus | undefined> {
    return this.#serialize(async () => {
      const definition = await this.#definition(pluginId, this.#require(pluginId));
      return this.#kernel.secrets(definition).setUserValue(name, value);
    });
  }

  /** A panel delete. `undefined` when the plugin declares no user-settable secret `name`. */
  deleteSecret(pluginId: string, name: string): Promise<SecretStatus | undefined> {
    return this.#serialize(async () => {
      const definition = await this.#definition(pluginId, this.#require(pluginId));
      return this.#kernel.secrets(definition).deleteUserValue(name);
    });
  }

  enable(pluginId: string, options: { readonly withDependencies?: boolean } = {}): Promise<void> {
    return this.#serialize(async () => {
      this.#require(pluginId);
      const problem = this.#problems.get(pluginId);
      if (problem !== undefined) {
        throw new Error(`Plugin "${pluginId}" cannot be loaded: ${problem}`);
      }
      const missing = this.#requiredClosure(pluginId).filter((id) => !this.#kernel.isRunning(id));
      if (missing.length > 0 && options.withDependencies !== true) {
        throw new DependencyActionRequired(
          `Enabling "${pluginId}" also enables: ${missing.join(', ')}`,
          missing,
        );
      }
      for (const id of missing) {
        this.#store.setEnabled(id, true);
        await this.#startOne(id);
      }
      this.#store.setEnabled(pluginId, true);
      await this.#startOne(pluginId);
      const status = this.#status.get(pluginId);
      if (status?.state === 'failed') {
        throw new Error(status.error ?? `Plugin "${pluginId}" failed to start`);
      }
    });
  }

  disable(pluginId: string, options: { readonly withDependents?: boolean } = {}): Promise<void> {
    return this.#serialize(async () => {
      this.#require(pluginId);
      const affected = this.#dependentsClosure(pluginId).filter(
        (id) => this.#kernel.isRunning(id) || this.#store.isEnabled(id),
      );
      if (affected.length > 0 && options.withDependents !== true) {
        throw new DependencyActionRequired(
          `Disabling "${pluginId}" also disables: ${affected.join(', ')}`,
          affected,
        );
      }
      for (const id of [...affected].reverse()) {
        this.#store.setEnabled(id, false);
        await this.#stopOne(id);
      }
      this.#store.setEnabled(pluginId, false);
      await this.#stopOne(pluginId);
    });
  }

  /** Restarts a running plugin with freshly imported code, and its running dependents. */
  reload(pluginId: string): Promise<void> {
    return this.#serialize(async () => {
      this.#require(pluginId);
      if (!this.#kernel.isRunning(pluginId)) throw new Error(`Plugin "${pluginId}" is not running`);
      const dependents = this.#dependentsClosure(pluginId).filter((id) =>
        this.#kernel.isRunning(id),
      );
      for (const id of [...dependents].reverse()) await this.#stopOne(id);
      await this.#stopOne(pluginId);
      await this.#startOne(pluginId);
      for (const id of dependents) await this.#startOne(id);
      const status = this.#status.get(pluginId);
      if (status?.state === 'failed') {
        throw new Error(status.error ?? `Plugin "${pluginId}" failed to restart`);
      }
    });
  }

  updateSettings(pluginId: string, patch: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#serialize(async () => {
      const plugin = this.#require(pluginId);
      const definition = await this.#definition(pluginId, plugin);
      return this.#kernel.updateSettings(definition, patch);
    });
  }

  deleteData(pluginId: string): Promise<string[]> {
    return this.#serialize(() => {
      this.#require(pluginId);
      if (this.#store.isEnabled(pluginId)) {
        throw new Error(`Disable plugin "${pluginId}" before deleting its data`);
      }
      return Promise.resolve(this.#kernel.deleteData(pluginId));
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Returns the plugins that were not known before this scan. */
  async #scan(): Promise<string[]> {
    const discovery = await discoverPlugins(this.#roots);
    this.#discoveryProblems = discovery.problems;
    for (const problem of discovery.problems) {
      this.#logger.warn('Plugin discovery problem', { dir: problem.dir, error: problem.message });
    }
    const plugins = new Map(discovery.plugins);
    // A running plugin whose folder disappeared stays known until it is stopped.
    for (const [id, plugin] of this.#plugins) {
      if (!plugins.has(id) && this.#kernel.isRunning(id)) plugins.set(id, plugin);
    }
    const nodes = new Map<string, GraphNode>(
      [...plugins].map(([id, plugin]) => [
        id,
        {
          id,
          version: plugin.version,
          dependencies: plugin.manifest.dependencies,
          optionalDependencies: plugin.manifest.optionalDependencies,
        },
      ]),
    );
    const graph = resolveGraph(nodes);
    const removed = [...this.#plugins.keys()].filter((id) => !plugins.has(id));
    const previous = new Set(this.#plugins.keys());
    this.#plugins = plugins;
    // Stopped plugins may have new code on disk; running ones keep theirs until reloaded.
    for (const id of [...this.#definitions.keys()]) {
      if (!this.#kernel.isRunning(id)) this.#definitions.delete(id);
    }
    for (const id of removed) {
      this.#status.delete(id);
      for (const listener of this.#removedListeners) {
        try {
          listener(id);
        } catch (error) {
          this.#logger.error('Plugin removal listener failed', { error: errorMessage(error) });
        }
      }
    }
    const appeared = [...plugins.keys()].filter((id) => !previous.has(id));
    if (this.#startNewPlugins) {
      for (const id of appeared) {
        if (this.#store.has(id)) continue;
        this.#store.setEnabled(id, true);
        this.#logger.info('Enabled a new plugin (dev)', { plugin: id });
      }
    }
    this.#problems = new Map(graph.problems);
    this.#order = graph.order;
    for (const id of plugins.keys()) {
      const problem = this.#problems.get(id);
      const current = this.#status.get(id);
      let next: Status | undefined;
      if (problem !== undefined && !this.#kernel.isRunning(id)) {
        next = { state: 'failed', error: problem, source: 'graph' };
      } else if (!current) {
        next = { state: 'disabled' };
      } else if (
        current.state === 'failed' &&
        current.source === 'graph' &&
        problem === undefined
      ) {
        next = { state: 'disabled' };
      }
      if (next && (next.state !== current?.state || next.error !== current.error)) {
        this.#set(id, next);
      }
    }
    return appeared;
  }

  async #startOne(pluginId: string): Promise<void> {
    if (this.#kernel.isRunning(pluginId)) return;
    let plugin = this.#require(pluginId);
    const problem = this.#problems.get(pluginId);
    if (problem !== undefined) {
      this.#set(pluginId, { state: 'failed', error: problem, source: 'graph' });
      return;
    }
    const notRunning = this.#requiredOf(pluginId).filter((id) => !this.#kernel.isRunning(id));
    if (notRunning.length > 0) {
      this.#set(pluginId, {
        state: 'failed',
        error: `Required dependency not running: ${notRunning.join(', ')}`,
        source: 'runtime',
      });
      return;
    }
    this.#set(pluginId, { state: 'starting' });
    try {
      // The build may have changed the entries since the scan (a rebuild before a reload).
      const entries = await readBuildInfo(plugin.dir);
      if ('message' in entries) throw new Error(entries.message);
      plugin = { ...plugin, entries };
      this.#plugins.set(pluginId, plugin);
      const definition = await runInPlugin(pluginId, () => this.#load(plugin));
      // Before setup: a declared overlay without a bundle would leave its instances blank.
      const unbuilt = Object.keys(definition.contract.overlays ?? {}).filter(
        (name) => !Object.hasOwn(plugin.entries.overlays, name),
      );
      if (unbuilt.length > 0) {
        throw new Error(
          unbuilt
            .map(
              (name) =>
                `Overlay "${name}" is declared in the contract but was not built (src/overlays/${name}.tsx)`,
            )
            .join('; '),
        );
      }
      // Before setup: an oversized bundle refuses the start without running plugin code.
      const bundles = await readPluginBundles(plugin, this.#maxBundleBytes);
      for (const problem of bundles.problems) {
        this.#logger.warn('Plugin bundle unavailable', { plugin: pluginId, error: problem });
      }
      for (const name of bundles.overlays.keys()) {
        if (!Object.hasOwn(definition.contract.overlays ?? {}, name)) {
          this.#logger.warn('Overlay bundle without a declaration in the contract', {
            plugin: pluginId,
            overlay: name,
          });
        }
      }
      await this.#kernel.start(definition, { dir: plugin.dir });
      this.#definitions.set(pluginId, definition);
      this.#bundles.set(pluginId, bundles);
      this.#set(pluginId, { state: 'running' });
    } catch (error) {
      this.#logger.error('Plugin failed to start', {
        plugin: pluginId,
        error: errorMessage(error),
      });
      this.#set(pluginId, { state: 'failed', error: errorMessage(error), source: 'runtime' });
    }
  }

  async #stopOne(pluginId: string): Promise<void> {
    if (!this.#kernel.isRunning(pluginId)) {
      if (this.#status.get(pluginId)?.state !== 'disabled' && !this.#problems.has(pluginId)) {
        this.#set(pluginId, { state: 'disabled' });
      }
      return;
    }
    this.#set(pluginId, { state: 'stopping' });
    await this.#kernel.stop(pluginId);
    this.#bundles.delete(pluginId);
    this.#set(pluginId, { state: 'disabled' });
  }

  /** The cached definition, or a fresh import that is then cached (stopped plugins). */
  async #definition(pluginId: string, plugin: DiscoveredPlugin): Promise<AnyPluginDefinition> {
    const cached = this.#definitions.get(pluginId);
    if (cached) return cached;
    const definition = await runInPlugin(pluginId, () => this.#load(plugin));
    this.#definitions.set(pluginId, definition);
    return definition;
  }

  #require(pluginId: string): DiscoveredPlugin {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) throw new Error(`Unknown plugin "${pluginId}"`);
    return plugin;
  }

  #requiredOf(pluginId: string): string[] {
    return Object.keys(this.#plugins.get(pluginId)?.manifest.dependencies ?? {});
  }

  /** Transitive required dependencies of `pluginId`, in start order. */
  #requiredClosure(pluginId: string): string[] {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      for (const dep of this.#requiredOf(id)) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        visit(dep);
      }
    };
    visit(pluginId);
    return this.#order.filter((id) => seen.has(id));
  }

  /** Plugins that transitively require `pluginId`, in start order. */
  #dependentsClosure(pluginId: string): string[] {
    return this.#order.filter(
      (id) => id !== pluginId && this.#requiredClosure(id).includes(pluginId),
    );
  }

  #set(pluginId: string, status: Status): void {
    this.#status.set(pluginId, status);
    this.#notify(pluginId);
  }

  #notify(pluginId: string): void {
    if (!this.#plugins.has(pluginId)) return;
    const info = this.#info(pluginId);
    for (const listener of this.#listeners) {
      try {
        listener(info);
      } catch (error) {
        this.#logger.error('Plugin state listener failed', { error: errorMessage(error) });
      }
    }
  }

  #info(pluginId: string): PluginInfo {
    const plugin = this.#require(pluginId);
    const status = this.#status.get(pluginId) ?? { state: 'disabled' };
    const definition = this.#definitions.get(pluginId);
    const bundle = this.#bundles.get(pluginId)?.panel;
    const base = bundle ? `/plugins/${pluginId}/${bundle.hash}/` : '';
    return {
      id: pluginId,
      version: plugin.version,
      dir: plugin.dir,
      state: status.state,
      enabled: this.#store.isEnabled(pluginId),
      degraded: this.#kernel.isDegraded(pluginId),
      ...(status.error === undefined ? {} : { error: status.error }),
      dependencies: Object.keys(plugin.manifest.dependencies),
      optionalDependencies: Object.keys(plugin.manifest.optionalDependencies),
      hasPanel: plugin.entries.panel !== undefined,
      ...(definition
        ? {
            hasSettings:
              definition.contract.settings !== undefined || hasUserSecrets(definition.contract),
          }
        : {}),
      ...(bundle
        ? {
            panel: {
              entry: base + encodeURIComponent(bundle.entry),
              styles: bundle.styles.map((style) => base + encodeURIComponent(style)),
            },
          }
        : {}),
    };
  }
}
