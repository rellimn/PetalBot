import { isDeepStrictEqual } from 'node:util';
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
import type { EventBus, RawEventHandler } from './event-bus.ts';
import type { HookRunner, RawHookHandler } from './hook-runner.ts';
import { ownerOf, splitName } from './names.ts';
import type { PluginRouteTable } from './plugin-routes.ts';
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
  readonly settings: PluginSettings;
  readonly schedule: ScheduleApi;
  readonly routes: PluginRouteTable;
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
  };
  readonly secrets: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  readonly schedule: ScheduleApi;
  readonly http: {
    route(
      method: string,
      path: string,
      handler: HttpHandler,
      options?: HttpRouteOptions,
    ): () => void;
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
  onDispose(fn: () => MaybePromise<void>): void;
}

export interface CreateContextOptions {
  readonly definition: AnyPluginDefinition;
  readonly loadIndex: number;
  readonly scope: DisposerScope;
  readonly services: ContextServices;
  readonly log: Logger;
}

/** True if `value` comes back unchanged from a JSON round trip. */
const isJsonSafe = (value: unknown): boolean => {
  try {
    // Typed as string, but returns undefined for functions, symbols and undefined.
    const json = JSON.stringify(value) as string | undefined;
    return json !== undefined && isDeepStrictEqual(JSON.parse(json), value);
  } catch {
    return false;
  }
};

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
    },
    secrets: {
      get: (name) =>
        attempt(() => {
          assertLive();
          return services.storage.secrets.get(pluginId, name);
        }),
      set: (name, value) =>
        attempt(() => {
          assertLive();
          services.storage.secrets.set(pluginId, name, value);
        }),
      delete: (name) =>
        attempt(() => {
          assertLive();
          services.storage.secrets.delete(pluginId, name);
        }),
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
    onDispose(fn) {
      assertLive();
      scope.add(fn);
    },
  };
}
