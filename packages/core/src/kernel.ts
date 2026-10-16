import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AccessError,
  PluginUnavailableError,
  type AnyPluginDefinition,
  type ContractShape,
  type EventDef,
  type EventEnvelope,
  type Logger,
  type MaybePromise,
  type Actor,
  type RpcClient,
  type RpcDef,
} from '@petalbot/sdk';
import { ContractRegistry, type Owned } from './contract-registry.ts';
import { DisposerScope, once } from './disposer-scope.ts';
import { EventBus } from './event-bus.ts';
import { HookRunner } from './hook-runner.ts';
import { isInside } from './fs-paths.ts';
import { errorMessage } from './names.ts';
import { createPluginContext, type SettingsListener } from './plugin-context.ts';
import { PluginHealth, type HealthListener, type PluginHealthOptions } from './plugin-health.ts';
import { PluginRouteTable } from './plugin-routes.ts';
import { PluginSecrets, type SecretListener } from './plugin-secrets.ts';
import { currentPlugin, runInPlugin } from './plugin-scope.ts';
import { ProviderRegistry } from './provider-registry.ts';
import { RpcRouter, type RawRpcHandler } from './rpc-router.ts';
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
  /** Default timeout of provider calls (slot methods may declare their own). Default 5000 ms. */
  readonly providerTimeoutMs?: number;
  readonly maxEventDepth?: number;
  /** The instance's public URL; `ctx.http.url` builds on it. Default `http://localhost:8080`. */
  readonly publicUrl?: string;
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
  readonly #publicUrl: string;
  readonly #health: PluginHealth;
  readonly #contracts = new ContractRegistry();
  readonly #bus: EventBus;
  readonly #hooks: HookRunner;
  readonly #rpc: RpcRouter;
  readonly #providers: ProviderRegistry;
  readonly #running = new Map<string, RunningPlugin>();
  readonly #settings = new Map<string, SettingsState>();
  /** Per running plugin: secret name -> its `onChange` listeners. */
  readonly #secretListeners = new Map<string, Map<string, Set<SecretListener>>>();
  readonly routes: PluginRouteTable;
  #loadCounter = 0;

  constructor(options: KernelOptions) {
    this.#health = new PluginHealth(options.health);
    this.#logger = options.logger;
    this.#storage = options.storage ?? createStorage(openDatabase(':memory:'), randomBytes(32));
    this.#setupTimeoutMs = options.setupTimeoutMs ?? 10_000;
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 10_000;
    this.#listenerTimeoutMs = options.listenerTimeoutMs ?? 10_000;
    this.#publicUrl = options.publicUrl ?? 'http://localhost:8080';
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
    this.#providers = new ProviderRegistry({
      contracts: this.#contracts,
      ...(options.providerTimeoutMs === undefined ? {} : { timeoutMs: options.providerTimeoutMs }),
    });
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

  /**
   * Starts a plugin. Its required dependencies must already be running. `dir` is the plugin's
   * folder; plugins that declare `db` need it to find their migrations.
   */
  async start(
    definition: AnyPluginDefinition,
    options: { readonly dir?: string } = {},
  ): Promise<void> {
    const pluginId = definition.contract.id;
    if (this.#running.has(pluginId)) throw new Error(`Plugin "${pluginId}" is already running`);
    for (const dependency of definition.dependencies ?? []) {
      if (!this.#running.has(dependency.id)) throw new PluginUnavailableError(dependency.id);
    }
    checkOverlayDependencies(definition);
    const settings: SettingsState = { value: this.#loadSettings(definition), listeners: new Set() };
    const db = definition.db
      ? preparePluginDb(this.#storage.sqlite, pluginId, {
          schema: definition.db.schema,
          migrationsFolder: migrationsFolderOf(pluginId, definition.db, options.dir),
        })
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
      const secretListeners = new Map<string, Set<SecretListener>>();
      this.#secretListeners.set(pluginId, secretListeners);
      scope.add(() => {
        if (this.#secretListeners.get(pluginId) === secretListeners) {
          this.#secretListeners.delete(pluginId);
        }
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
          secrets: this.secrets(definition),
          subscribeSecret: (name, listener) => {
            let listeners = secretListeners.get(name);
            if (!listeners) {
              listeners = new Set();
              secretListeners.set(name, listeners);
            }
            const set = listeners;
            set.add(listener);
            return once(() => set.delete(listener));
          },
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
          publicUrl: this.#publicUrl,
          db,
          isRunning: (id) => this.isRunning(id),
        },
      });
      const result = await withTimeout(
        Promise.resolve().then(() => runInPlugin(pluginId, () => definition.setup(ctx as never))),
        this.#setupTimeoutMs,
        () =>
          new Error(
            `Setup of plugin "${pluginId}" timed out after ${String(this.#setupTimeoutMs)} ms`,
          ),
      );
      this.#registerRpcs(definition, result, scope);
    } catch (error) {
      await runInPlugin(pluginId, () => scope.dispose());
      throw error;
    }
    this.#running.set(pluginId, { definition, scope });
  }

  /** Checks what `setup` returned against the contract and registers the RPC implementations. */
  #registerRpcs(definition: AnyPluginDefinition, result: unknown, scope: DisposerScope): void {
    const pluginId = definition.contract.id;
    const members = Object.keys(definition.contract.rpc ?? {});
    const rpc =
      typeof result === 'object' && result !== null && 'rpc' in result ? result.rpc : undefined;
    if (rpc !== undefined && (typeof rpc !== 'object' || rpc === null)) {
      throw new Error(`Setup of plugin "${pluginId}" returned an rpc field that is not an object`);
    }
    const impls = (rpc ?? {}) as Readonly<Record<string, unknown>>;
    for (const name of Object.keys(impls)) {
      if (!members.includes(name)) {
        throw new Error(
          `Plugin "${pluginId}" implements "${name}", which is not an RPC of its contract`,
        );
      }
    }
    for (const member of members) {
      const handler = impls[member];
      if (typeof handler !== 'function') {
        throw new Error(
          `Plugin "${pluginId}" does not implement RPC "${member}" (setup must return { rpc: { ${member}: ... } })`,
        );
      }
      scope.add(this.#rpc.register(`${pluginId}.${member}`, handler as RawRpcHandler));
    }
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
    if (!definition.contract.settings)
      throw new AccessError(`Plugin "${pluginId}" declares no settings`);
    // Persist the validated *input*; the parsed output may not survive JSON or re-parsing.
    const merged = { ...this.#storage.settings.read(pluginId), ...patch };
    const next = parseOrThrow(
      definition.contract.settings,
      merged,
      `settings of plugin "${pluginId}"`,
    );
    this.#storage.settings.write(pluginId, merged);
    const state = this.#settings.get(pluginId);
    if (state) {
      const previous = state.value;
      state.value = next;
      for (const listener of [...state.listeners]) {
        await this.#runListener(pluginId, 'Settings listener', () => listener(next, previous));
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

  /** The declared secrets of `definition`'s plugin (works for stopped plugins). */
  secrets(definition: AnyPluginDefinition): PluginSecrets {
    const pluginId = definition.contract.id;
    return new PluginSecrets({
      store: this.#storage.secrets,
      contract: definition.contract,
      notify: (name, key) => this.#notifySecret(pluginId, name, key),
    });
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
    const actor: Actor =
      client.kind === 'panel'
        ? { kind: 'user', user: client.user }
        : { kind: 'overlay', instanceId: client.instanceId };
    return this.#rpc.call('client', name, input, { client, actor });
  }

  /** Stored settings of `definition`, parsed with its schema (works for stopped plugins). */
  readSettings(definition: AnyPluginDefinition): unknown {
    return this.#loadSettings(definition);
  }

  async #notifySecret(pluginId: string, name: string, key: string | undefined): Promise<void> {
    const listeners = this.#secretListeners.get(pluginId)?.get(name);
    for (const listener of [...(listeners ?? [])]) {
      await this.#runListener(pluginId, 'Secret listener', () => listener(key));
    }
  }

  /** Runs a plugin listener in its scope with the listener timeout; failures are logged. */
  async #runListener(
    pluginId: string,
    what: string,
    call: () => MaybePromise<void>,
  ): Promise<void> {
    try {
      await withTimeout(
        Promise.resolve().then(() => runInPlugin(pluginId, call)),
        this.#listenerTimeoutMs,
        () => new Error(`${what} timed out after ${String(this.#listenerTimeoutMs)} ms`),
      );
    } catch (error) {
      this.#logger.error(`${what} failed`, { plugin: pluginId, error: errorMessage(error) });
      this.#health.record(pluginId, 'handler');
    }
  }

  #loadSettings(definition: AnyPluginDefinition): unknown {
    const pluginId = definition.contract.id;
    if (!definition.contract.settings) return {};
    return parseOrThrow(
      definition.contract.settings,
      this.#storage.settings.read(pluginId),
      `stored settings of plugin "${pluginId}"`,
    );
  }
}

/** The plugin's migrations folder: `db.migrations` (default `drizzle`) inside its folder. */
function migrationsFolderOf(
  pluginId: string,
  db: { readonly migrations?: string },
  dir: string | undefined,
): string {
  if (dir === undefined) {
    throw new Error(
      `Plugin "${pluginId}" declares db, so the kernel needs its folder: start(definition, { dir })`,
    );
  }
  const folder = resolve(dir, db.migrations ?? 'drizzle');
  if (!isInside(dir, folder)) {
    throw new AccessError(
      `The migrations folder of plugin "${pluginId}" must be inside the plugin folder`,
    );
  }
  return folder;
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
