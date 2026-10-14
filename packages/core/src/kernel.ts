import { randomBytes } from 'node:crypto';
import {
  AccessError,
  PluginUnavailableError,
  type AnyPluginDefinition,
  type ContractShape,
  type EventDef,
  type EventEnvelope,
  type Logger,
  type RpcClient,
  type RpcDef,
} from '@petalbot/sdk';
import { ContractRegistry, type Owned } from './contract-registry.ts';
import { DisposerScope, once } from './disposer-scope.ts';
import { EventBus } from './event-bus.ts';
import { HookRunner } from './hook-runner.ts';
import { errorMessage } from './names.ts';
import { createPluginContext, type SettingsListener } from './plugin-context.ts';
import { PluginHealth, type HealthListener, type PluginHealthOptions } from './plugin-health.ts';
import { PluginRouteTable } from './plugin-routes.ts';
import { currentPlugin, runInPlugin } from './plugin-scope.ts';
import { ProviderRegistry } from './provider-registry.ts';
import { RpcRouter } from './rpc-router.ts';
import { createScheduler } from './scheduler.ts';
import { openDatabase } from './storage/database.ts';
import { dropPluginTables, preparePluginDb } from './storage/plugin-db.ts';
import { createStorage, type KernelStorage } from './storage/storage.ts';
import { withTimeout } from './timeout.ts';
import { parseOrThrow } from './validate.ts';

export interface KernelOptions {
  readonly logger: Logger;
  /** Default: an in-memory database with a random secret key (tests, harness). */
  readonly storage?: KernelStorage;
  /** Default 10 000 ms. */
  readonly setupTimeoutMs?: number;
  /** Per disposer when a plugin stops. Default 10 000 ms. */
  readonly disposeTimeoutMs?: number;
  /** Per settings `onChange` listener. Default 10 000 ms. */
  readonly listenerTimeoutMs?: number;
  readonly health?: PluginHealthOptions;
  readonly hookTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly maxEventDepth?: number;
}

interface RunningPlugin {
  readonly definition: AnyPluginDefinition;
  readonly scope: DisposerScope;
}

interface SettingsState {
  value: unknown;
  readonly listeners: Set<SettingsListener>;
}

/**
 * Hosts running plugins: wires them to the bus, hooks, RPC, providers and storage, and tracks
 * their health. Dependency ordering, manifests and enable/disable state live in PluginManager.
 */
export class Kernel {
  readonly #logger: Logger;
  readonly #storage: KernelStorage;
  readonly #setupTimeoutMs: number;
  readonly #disposeTimeoutMs: number;
  readonly #listenerTimeoutMs: number;
  readonly #health: PluginHealth;
  readonly #contracts = new ContractRegistry();
  readonly #bus: EventBus;
  readonly #hooks: HookRunner;
  readonly #rpc: RpcRouter;
  readonly #providers: ProviderRegistry;
  readonly #running = new Map<string, RunningPlugin>();
  readonly #settings = new Map<string, SettingsState>();
  readonly routes: PluginRouteTable;
  #loadCounter = 0;

  constructor(options: KernelOptions) {
    this.#health = new PluginHealth(options.health);
    this.#logger = options.logger;
    this.#storage = options.storage ?? createStorage(openDatabase(':memory:'), randomBytes(32));
    this.#setupTimeoutMs = options.setupTimeoutMs ?? 10_000;
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 10_000;
    this.#listenerTimeoutMs = options.listenerTimeoutMs ?? 10_000;
    this.#bus = new EventBus({
      contracts: this.#contracts,
      logger: options.logger,
      onHandlerError: (pluginId) => {
        this.#health.record(pluginId, 'handler');
      },
      ...(options.maxEventDepth === undefined ? {} : { maxDepth: options.maxEventDepth }),
    });
    this.#hooks = new HookRunner({
      contracts: this.#contracts,
      logger: options.logger,
      onHandlerError: (pluginId) => {
        this.#health.record(pluginId, 'hook');
      },
      ...(options.hookTimeoutMs === undefined ? {} : { timeoutMs: options.hookTimeoutMs }),
    });
    this.#rpc = new RpcRouter({
      contracts: this.#contracts,
      ...(options.rpcTimeoutMs === undefined ? {} : { timeoutMs: options.rpcTimeoutMs }),
    });
    this.#providers = new ProviderRegistry(this.#contracts);
    this.routes = new PluginRouteTable({
      onError: (pluginId, error) => {
        this.#logger.error('Plugin route failed', { plugin: pluginId, error: errorMessage(error) });
        this.#health.record(pluginId, 'route');
      },
    });
  }

  isRunning(pluginId: string): boolean {
    return this.#running.has(pluginId);
  }

  isDegraded(pluginId: string): boolean {
    return this.#health.isDegraded(pluginId);
  }

  onHealthChange(listener: HealthListener): () => void {
    return this.#health.onChange(listener);
  }

  /** Attributes an uncaught error to the plugin whose code raised it; false for core errors. */
  reportUncaught(error: unknown): boolean {
    const pluginId = currentPlugin();
    if (pluginId === undefined) return false;
    this.#logger.error('Uncaught error in plugin', {
      plugin: pluginId,
      error: errorMessage(error),
    });
    this.#health.record(pluginId, 'uncaught');
    return true;
  }

  /** Starts a plugin. Its required dependencies must already be running. */
  async start(definition: AnyPluginDefinition): Promise<void> {
    const pluginId = definition.contract.id;
    if (this.#running.has(pluginId)) throw new Error(`Plugin "${pluginId}" is already running`);
    for (const dependency of definition.dependencies ?? []) {
      if (!this.#running.has(dependency.id)) throw new PluginUnavailableError(dependency.id);
    }
    checkOverlayDependencies(definition);
    const settings: SettingsState = { value: this.#loadSettings(definition), listeners: new Set() };
    const db = definition.db
      ? preparePluginDb(this.#storage.sqlite, pluginId, definition.db)
      : undefined;
    this.#health.reset(pluginId);

    const log = this.#logger.child({ plugin: pluginId });
    const scope = new DisposerScope(log, { timeoutMs: this.#disposeTimeoutMs });
    try {
      scope.add(this.#contracts.register(definition.contract));
      this.#settings.set(pluginId, settings);
      scope.add(() => {
        this.#settings.delete(pluginId);
      });
      const ctx = createPluginContext({
        definition,
        loadIndex: this.#loadCounter++,
        scope,
        log,
        services: {
          bus: this.#bus,
          hooks: this.#hooks,
          rpc: this.#rpc,
          providers: this.#providers,
          storage: this.#storage,
          settings: {
            current: () => settings.value,
            subscribe: (listener) => {
              settings.listeners.add(listener);
              return once(() => settings.listeners.delete(listener));
            },
          },
          schedule: createScheduler({
            pluginId,
            onError: (error) => {
              log.error('Scheduled task failed', { error: errorMessage(error) });
              this.#health.record(pluginId, 'schedule');
            },
          }),
          routes: this.routes,
          db,
          isRunning: (id) => this.isRunning(id),
        },
      });
      for (const member of Object.keys(definition.contract.rpc ?? {})) {
        const handler = definition.rpc?.[member];
        if (!handler) throw new Error(`Plugin "${pluginId}" does not implement RPC "${member}"`);
        scope.add(
          this.#rpc.register(`${pluginId}.${member}`, (input, meta) =>
            handler(input, { ...meta, ctx } as never),
          ),
        );
      }
      await withTimeout(
        Promise.resolve().then(() => runInPlugin(pluginId, () => definition.setup(ctx as never))),
        this.#setupTimeoutMs,
        () =>
          new Error(
            `Setup of plugin "${pluginId}" timed out after ${String(this.#setupTimeoutMs)} ms`,
          ),
      );
    } catch (error) {
      await runInPlugin(pluginId, () => scope.dispose());
      throw error;
    }
    this.#running.set(pluginId, { definition, scope });
  }

  /** Stops a plugin and runs all of its disposers in reverse order. */
  async stop(pluginId: string): Promise<void> {
    const plugin = this.#running.get(pluginId);
    if (!plugin) return;
    this.#running.delete(pluginId);
    await runInPlugin(pluginId, () => plugin.scope.dispose());
  }

  /**
   * Validates `{ ...stored, ...patch }` against the plugin's schema and persists the result.
   * Running plugins are notified through their `onChange` listeners.
   */
  async updateSettings(
    definition: AnyPluginDefinition,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const pluginId = definition.contract.id;
    if (!definition.settings) throw new AccessError(`Plugin "${pluginId}" declares no settings`);
    // Persist the validated *input*; the parsed output may not survive JSON or re-parsing.
    const merged = { ...this.#storage.settings.read(pluginId), ...patch };
    const next = parseOrThrow(definition.settings, merged, `settings of plugin "${pluginId}"`);
    this.#storage.settings.write(pluginId, merged);
    const state = this.#settings.get(pluginId);
    if (state) {
      const previous = state.value;
      state.value = next;
      for (const listener of [...state.listeners]) {
        try {
          await withTimeout(
            Promise.resolve().then(() => runInPlugin(pluginId, () => listener(next, previous))),
            this.#listenerTimeoutMs,
            () =>
              new Error(`settings listener timed out after ${String(this.#listenerTimeoutMs)} ms`),
          );
        } catch (error) {
          this.#logger.error('Settings listener failed', {
            plugin: pluginId,
            error: errorMessage(error),
          });
          this.#health.record(pluginId, 'handler');
        }
      }
    }
    return next;
  }

  /** Removes all data of a stopped plugin. Returns the dropped table names. */
  deleteData(pluginId: string): string[] {
    if (this.#running.has(pluginId)) {
      throw new Error(`Stop plugin "${pluginId}" before deleting its data`);
    }
    const dropped = dropPluginTables(this.#storage.sqlite, pluginId);
    this.#storage.kv.deleteAll(pluginId);
    this.#storage.settings.delete(pluginId);
    this.#storage.secrets.deleteAll(pluginId);
    return dropped;
  }

  /** Core-internal tap on every event. */
  tap(fn: (event: EventEnvelope) => void): () => void {
    return this.#bus.tap(fn);
  }

  /** Resolves when all queued events have been handled. */
  idle(): Promise<void> {
    return this.#bus.idle();
  }

  /** The contract of a running plugin. */
  contract(pluginId: string): ContractShape | undefined {
    return this.#contracts.get(pluginId);
  }

  eventDef(name: string): Owned<EventDef> | undefined {
    return this.#contracts.event(name);
  }

  rpcDef(name: string): Owned<RpcDef> | undefined {
    return this.#contracts.rpc(name);
  }

  /** Calls an RPC for a browser client. Exposure checks are the gateway's job. */
  callFromClient(name: string, input: unknown, client: RpcClient): Promise<unknown> {
    return this.#rpc.call('client', name, input, { client });
  }

  /** Stored settings of `definition`, parsed with its schema (works for stopped plugins). */
  readSettings(definition: AnyPluginDefinition): unknown {
    return this.#loadSettings(definition);
  }

  #loadSettings(definition: AnyPluginDefinition): unknown {
    const pluginId = definition.contract.id;
    if (!definition.settings) return {};
    return parseOrThrow(
      definition.settings,
      this.#storage.settings.read(pluginId),
      `stored settings of plugin "${pluginId}"`,
    );
  }
}

/** An overlay may only use contracts its plugin depends on. */
function checkOverlayDependencies(definition: AnyPluginDefinition): void {
  const pluginId = definition.contract.id;
  const allowed = new Set([
    pluginId,
    ...(definition.dependencies ?? []).map((c) => c.id),
    ...(definition.optionalDependencies ?? []).map((c) => c.id),
  ]);
  for (const [name, overlay] of Object.entries(definition.contract.overlays ?? {})) {
    for (const dependency of overlay.dependencies ?? []) {
      if (!allowed.has(dependency.id)) {
        throw new Error(
          `Overlay "${name}" of plugin "${pluginId}" uses "${dependency.id}", which is not a dependency of the plugin`,
        );
      }
    }
  }
}
