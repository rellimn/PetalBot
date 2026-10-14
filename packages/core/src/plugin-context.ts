import {
  AccessError,
  PluginUnavailableError,
  type AnyPluginDefinition,
  type CallOptions,
  type HookOptions,
  type HttpHandler,
  type HttpRouteOptions,
  type Logger,
  type MaybePromise,
  type ScheduleApi,
} from '@petalbot/sdk';
import type { DisposerScope } from './disposer-scope.ts';
import { isJsonSafe } from './json-safe.ts';
import { KeyedLock } from './keyed-lock.ts';
import type { EventBus, RawEventHandler } from './event-bus.ts';
import type { HookRunner, RawHookHandler } from './hook-runner.ts';
import { ownerOf, splitName } from './names.ts';
import { isRoutePath, type PluginRouteTable } from './plugin-routes.ts';
import type { PluginSecrets, SecretListener } from './plugin-secrets.ts';
import type { ProviderRegistry, RawProviderImpl } from './provider-registry.ts';
import type { RpcRouter } from './rpc-router.ts';
import type { KernelStorage } from './storage/storage.ts';
import { parseOrThrow } from './validate.ts';

export type SettingsListener = (next: unknown, previous: unknown) => MaybePromise<void>;

export interface PluginSettings {
  current(): unknown;
  subscribe(listener: SettingsListener): () => void;
}

export interface ContextServices {
  readonly bus: EventBus;
  readonly hooks: HookRunner;
  readonly rpc: RpcRouter;
  readonly providers: ProviderRegistry;
  readonly storage: KernelStorage;
  /** The plugin's declared secrets. */
  readonly secrets: PluginSecrets;
  /** Registers an `onChange` listener for secret `name`; the returned function removes it. */
  subscribeSecret(name: string, listener: SecretListener): () => void;
  readonly settings: PluginSettings;
  readonly schedule: ScheduleApi;
  readonly routes: PluginRouteTable;
  /** The instance's public URL, for `http.url`. */
  readonly publicUrl: string;
  /** The plugin's drizzle database, if it declares `db`. */
  readonly db: unknown;
  isRunning(pluginId: string): boolean;
}

/** Runtime shape of {@link PluginContext}; the typed interface is applied by `definePlugin`. */
export interface RuntimeContext {
  readonly pluginId: string;
  readonly log: Logger;
  readonly settings: { get(): unknown; onChange(listener: SettingsListener): () => void };
  readonly kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    update(key: string, updater: (current: unknown) => unknown): Promise<unknown>;
  };
  readonly secrets: {
    get(name: string, key?: string): Promise<unknown>;
    set(name: string, ...args: readonly unknown[]): Promise<void>;
    delete(name: string, key?: string): Promise<void>;
    keys(name: string): Promise<string[]>;
    onChange(name: string, listener: SecretListener): () => void;
  };
  readonly schedule: ScheduleApi;
  readonly http: {
    route(
      method: string,
      path: string,
      handler: HttpHandler,
      options?: HttpRouteOptions,
    ): () => void;
    url(path: string): string;
  };
  readonly db: unknown;
  on(name: string, handler: RawEventHandler): () => void;
  emit(name: string, payload: unknown): void;
  hook(name: string, handler: RawHookHandler, options?: HookOptions): () => void;
  runHook(name: string, input: unknown): Promise<unknown>;
  call(name: string, input: unknown, options?: CallOptions): Promise<unknown>;
  provide(slot: string, key: string, impl: RawProviderImpl): () => void;
  providers(slot: string): unknown;
  isRunning(pluginId: string): boolean;
  lock(key: string, fn: () => MaybePromise<unknown>): Promise<unknown>;
  onDispose(fn: () => MaybePromise<void>): void;
}

export interface CreateContextOptions {
  readonly definition: AnyPluginDefinition;
  readonly loadIndex: number;
  readonly scope: DisposerScope;
  readonly services: ContextServices;
  readonly log: Logger;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  'then' in value &&
  typeof value.then === 'function';

/** Runs `fn`, turning a synchronous throw into a rejected promise. */
const attempt = <T>(fn: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(fn());
  });

export function createPluginContext(options: CreateContextOptions): RuntimeContext {
  const { definition, loadIndex, scope, services, log } = options;
  const pluginId = definition.contract.id;
  const dependencies = [
    ...(definition.dependencies ?? []),
    ...(definition.optionalDependencies ?? []),
  ];
  const dependencyIds = new Set(dependencies.map((c) => c.id));

  const assertOwner = (name: string, allowOwn: boolean, allowDeps: boolean, what: string) => {
    const owner = ownerOf(name);
    const allowed =
      owner !== undefined &&
      ((allowOwn && owner === pluginId) || (allowDeps && dependencyIds.has(owner)));
    if (!allowed) throw new AccessError(`Plugin "${pluginId}" cannot ${what} "${name}"`);
  };

  /** A stopped (or failed) plugin's ctx must not register, emit or call anything. */
  const assertLive = () => {
    if (scope.closed) throw new PluginUnavailableError(pluginId);
  };

  const track = (disposer: () => void): (() => void) => {
    scope.add(disposer);
    return disposer;
  };

  const kvSchema = (key: string) => {
    const schema =
      definition.kv && Object.hasOwn(definition.kv, key) ? definition.kv[key] : undefined;
    if (!schema) throw new AccessError(`Plugin "${pluginId}" declares no kv key "${key}"`);
    return schema;
  };

  const locks = new KeyedLock();
  // On close, not as a disposer: queued calls must reject before slow disposers are awaited.
  scope.onClose(() => {
    locks.close(new PluginUnavailableError(pluginId));
  });

  return {
    pluginId,
    log,
    settings: {
      get() {
        assertLive();
        return services.settings.current();
      },
      onChange(listener) {
        assertLive();
        return track(services.settings.subscribe(listener));
      },
    },
    kv: {
      get: (key) =>
        attempt(() => {
          assertLive();
          const schema = kvSchema(key);
          const stored = services.storage.kv.get(pluginId, key);
          return stored === undefined
            ? undefined
            : parseOrThrow(schema, stored, `stored kv "${key}" of plugin "${pluginId}"`);
        }),
      set: (key, value) =>
        attempt(() => {
          assertLive();
          // Validate, but persist the *input*: `get` parses it again into the output.
          parseOrThrow(kvSchema(key), value, `kv "${key}" of plugin "${pluginId}"`);
          if (value === undefined) {
            services.storage.kv.delete(pluginId, key);
            return;
          }
          if (!isJsonSafe(value)) {
            throw new Error(`kv "${key}" of plugin "${pluginId}" must be JSON-serializable`);
          }
          services.storage.kv.set(pluginId, key, value);
        }),
      delete: (key) =>
        attempt(() => {
          assertLive();
          kvSchema(key);
          services.storage.kv.delete(pluginId, key);
        }),
      update: (key, updater) =>
        attempt(() => {
          assertLive();
          const schema = kvSchema(key);
          const where = `kv "${key}" of plugin "${pluginId}"`;
          const stored = services.storage.kv.update(pluginId, key, (raw) => {
            const current =
              raw === undefined ? undefined : parseOrThrow(schema, raw, `stored ${where}`);
            const next: unknown = updater(current);
            if (isPromiseLike(next)) {
              // The promise may still reject later: keep that from becoming an unhandled rejection.
              Promise.resolve(next).catch(() => undefined);
              throw new TypeError(
                `The updater of ${where} must be synchronous (it returned a promise)`,
              );
            }
            if (next === undefined) return undefined;
            parseOrThrow(schema, next, where);
            if (!isJsonSafe(next)) throw new Error(`${where} must be JSON-serializable`);
            return next;
          });
          return stored === undefined ? undefined : parseOrThrow(schema, stored, where);
        }),
    },
    secrets: {
      get: (name, key) =>
        attempt(() => {
          assertLive();
          return services.secrets.get(name, key);
        }),
      async set(name, ...args) {
        assertLive();
        // Keyed secrets take (key, value), single ones (value).
        const keyed = services.secrets.def(name).keyed === true;
        await services.secrets.set(name, keyed ? args[0] : undefined, keyed ? args[1] : args[0]);
      },
      async delete(name, key) {
        assertLive();
        await services.secrets.delete(name, key);
      },
      keys: (name) =>
        attempt(() => {
          assertLive();
          return services.secrets.keys(name);
        }),
      onChange(name, listener) {
        assertLive();
        services.secrets.def(name);
        return track(services.subscribeSecret(name, listener));
      },
    },
    schedule: {
      after(ms, task) {
        assertLive();
        return track(services.schedule.after(ms, task));
      },
      every(ms, task) {
        assertLive();
        return track(services.schedule.every(ms, task));
      },
      cron(expression, task) {
        assertLive();
        return track(services.schedule.cron(expression, task));
      },
    },
    http: {
      route(method, path, handler, routeOptions) {
        assertLive();
        return track(services.routes.register(pluginId, method, path, handler, routeOptions));
      },
      url(path) {
        assertLive();
        if (!isRoutePath(path)) {
          throw new AccessError(`Invalid route path "${path}" (must start with "/")`);
        }
        return new URL(`/api/p/${pluginId}${path}`, services.publicUrl).href;
      },
    },
    get db() {
      assertLive();
      if (services.db === undefined) {
        throw new AccessError(`Plugin "${pluginId}" declares no db`);
      }
      return services.db;
    },
    on(name, handler) {
      assertLive();
      assertOwner(name, true, true, 'subscribe to');
      return track(services.bus.subscribe(pluginId, name, handler));
    },
    emit(name, payload) {
      assertLive();
      services.bus.emit(pluginId, name, payload);
    },
    hook(name, handler, hookOptions) {
      assertLive();
      assertOwner(name, true, true, 'tap');
      return track(
        services.hooks.tap(pluginId, loadIndex, name, handler, hookOptions?.priority ?? 0),
      );
    },
    async runHook(name, input) {
      assertLive();
      return await services.hooks.run(pluginId, name, input);
    },
    async call(name, input, callOptions) {
      assertLive();
      assertOwner(name, false, true, 'call');
      return await services.rpc.call(pluginId, name, input, callOptions);
    },
    provide(slot, key, impl) {
      assertLive();
      assertOwner(slot, false, true, 'provide');
      const [owner, member] = splitName(slot) ?? ['', ''];
      const slotDef = dependencies.find((c) => c.id === owner)?.providers?.[member];
      if (!slotDef) throw new AccessError(`Unknown provider slot "${slot}"`);
      return track(services.providers.register(pluginId, slot, slotDef, key, impl));
    },
    providers(slot) {
      assertLive();
      assertOwner(slot, true, false, 'resolve providers of');
      const member = splitName(slot)?.[1] ?? '';
      if (!definition.contract.providers?.[member]) {
        throw new AccessError(`Unknown provider slot "${slot}"`);
      }
      return services.providers.view(slot);
    },
    isRunning(id) {
      assertLive();
      if (!dependencyIds.has(id)) {
        throw new AccessError(`Plugin "${pluginId}" cannot check "${id}" (not a dependency)`);
      }
      return services.isRunning(id);
    },
    lock(key, fn) {
      assertLive();
      return locks.run(key, fn);
    },
    onDispose(fn) {
      assertLive();
      scope.add(fn);
    },
  };
}
