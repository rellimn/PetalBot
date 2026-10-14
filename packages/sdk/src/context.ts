import type { z } from 'zod';
import type { ContractShape, ProviderSlotDef } from './contract.ts';
import type { EventEnvelope } from './envelope.ts';
import type { HttpApi } from './http.ts';
import type { Logger } from './logger.ts';
import type {
  DbSchema,
  KvApi,
  KvSchema,
  PluginDb,
  ScheduleApi,
  SecretsApi,
  SettingsApi,
} from './storage.ts';
import type {
  Disposer,
  EventDefsOf,
  HookDefsOf,
  MaybePromise,
  MergeMaps,
  NoMembers,
  ProviderSlotsOf,
  RpcDefsOf,
  RpcInputArgs,
} from './type-utils.ts';
import type { Veto } from './veto.ts';

type AllOf<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = Own | Deps[number] | Opt[number];
type DepsOf<Deps extends readonly ContractShape[], Opt extends readonly ContractShape[]> =
  Deps[number] | Opt[number];

/** Events a plugin may subscribe to: own + dependencies + optional dependencies. */
export type ListenableEvents<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<EventDefsOf<AllOf<Own, Deps, Opt>>>;
/** Events a plugin may emit: own only. */
export type EmittableEvents<Own extends ContractShape> = MergeMaps<EventDefsOf<Own>>;
export type TappableHooks<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<HookDefsOf<AllOf<Own, Deps, Opt>>>;
export type RunnableHooks<Own extends ContractShape> = MergeMaps<HookDefsOf<Own>>;
export type CallableRpc<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<RpcDefsOf<DepsOf<Deps, Opt>>>;
export type ImplementableSlots<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<ProviderSlotsOf<DepsOf<Deps, Opt>>>;
export type OwnedSlots<Own extends ContractShape> = MergeMaps<ProviderSlotsOf<Own>>;

/** The settings schema of a contract (an empty object schema when it declares none). */
export type SettingsOf<C extends ContractShape> = C extends {
  settings: infer S extends z.ZodObject;
}
  ? S
  : z.ZodObject<NoMembers>;

type SchemaOf<D, K extends string> = D extends Record<K, infer S extends z.ZodType> ? S : never;
type SlotOf<D> = D extends ProviderSlotDef ? D : never;

export type EventHandler<N extends string, P> = (event: EventEnvelope<N, P>) => MaybePromise<void>;

export interface HookApi {
  /** A property, not a method, so it can be destructured: `(input, { veto }) => ...`. */
  readonly veto: (reason: string) => Veto;
}

/** Return the (modified) input, nothing to pass it through unchanged, or `veto(...)`. */
export type HookHandler<S extends z.ZodType> = (
  input: z.output<S>,
  api: HookApi,
) => MaybePromise<z.input<S> | Veto | undefined>;

export type HookResult<T> =
  | { readonly vetoed: false; readonly value: T }
  | { readonly vetoed: true; readonly vetoedBy: string; readonly reason: string };

export interface CallOptions {
  readonly timeoutMs?: number;
}

export interface HookOptions {
  /** Higher runs first. Default 0. */
  readonly priority?: number;
}

/** What implementers register: every method optional  */
export type ProviderImpl<Slot extends ProviderSlotDef> = {
  readonly [M in keyof Slot]?: (
    input: z.output<Slot[M]['input']>,
  ) => Promise<z.input<Slot[M]['output']>>;
};

/** What the slot owner sees for one registered provider. */
export interface ProviderHandle<Slot extends ProviderSlotDef> {
  readonly key: string;
  readonly pluginId: string;
  /** Names of implemented methods. */
  readonly methods: readonly (keyof Slot & string)[];
  has(method: keyof Slot & string): boolean;
  /** Validates input and output; throws UnsupportedCapabilityError if not implemented. */
  call<M extends keyof Slot & string>(
    method: M,
    input: z.input<Slot[M]['input']>,
  ): Promise<z.output<Slot[M]['output']>>;
}

export interface ProviderView<Slot extends ProviderSlotDef> {
  keys(): string[];
  get(key: string): ProviderHandle<Slot> | undefined;
}

/**
 * The API a plugin's `setup` (and its RPC implementations) receive. Types are derived from the
 * plugin's own contract (Own), its dependencies (Deps, Opt) and its declared storage.
 */
export interface PluginContext<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
> {
  readonly pluginId: Own['id'];
  readonly log: Logger;
  /** Typed from the contract's `settings`. */
  readonly settings: SettingsApi<SettingsOf<Own>>;
  readonly kv: KvApi<Kv>;
  readonly secrets: SecretsApi;
  readonly schedule: ScheduleApi;
  /** HTTP routes under `/api/p/<pluginId>/…` */
  readonly http: HttpApi;
  /** The plugin's Drizzle database; only usable when the plugin declares `db`. */
  readonly db: [Db] extends [DbSchema] ? PluginDb<Db> : never;

  on<N extends keyof ListenableEvents<Own, Deps, Opt> & string>(
    name: N,
    handler: EventHandler<N, z.output<SchemaOf<ListenableEvents<Own, Deps, Opt>[N], 'schema'>>>,
  ): Disposer;

  emit<N extends keyof EmittableEvents<Own> & string>(
    name: N,
    payload: z.input<SchemaOf<EmittableEvents<Own>[N], 'schema'>>,
  ): void;

  hook<N extends keyof TappableHooks<Own, Deps, Opt> & string>(
    name: N,
    handler: HookHandler<SchemaOf<TappableHooks<Own, Deps, Opt>[N], 'input'>>,
    options?: HookOptions,
  ): Disposer;

  runHook<N extends keyof RunnableHooks<Own> & string>(
    name: N,
    input: z.input<SchemaOf<RunnableHooks<Own>[N], 'input'>>,
  ): Promise<HookResult<z.output<SchemaOf<RunnableHooks<Own>[N], 'input'>>>>;

  /** Calls a dependency's RPC. RPCs without input take none: `ctx.call('counter.list')`. */
  call<N extends keyof CallableRpc<Deps, Opt> & string>(
    name: N,
    ...args: [...RpcInputArgs<CallableRpc<Deps, Opt>[N]>, options?: CallOptions]
  ): Promise<z.output<SchemaOf<CallableRpc<Deps, Opt>[N], 'output'>>>;

  provide<N extends keyof ImplementableSlots<Deps, Opt> & string>(
    slot: N,
    key: string,
    impl: ProviderImpl<SlotOf<ImplementableSlots<Deps, Opt>[N]>>,
  ): Disposer;

  providers<N extends keyof OwnedSlots<Own> & string>(
    slot: N,
  ): ProviderView<SlotOf<OwnedSlots<Own>[N]>>;

  /** Whether a (usually optional) dependency is running right now. */
  isRunning(pluginId: Deps[number]['id'] | Opt[number]['id']): boolean;

  /**
   * Runs `fn` while holding the plugin's lock named `key`: calls with the same key run one at a
   * time (FIFO), different keys in parallel. For async read-call-write sections; use
   * `kv.update` or a single SQL statement when nothing is awaited in between.
   */
  lock<T>(key: string, fn: () => MaybePromise<T>): Promise<T>;

  onDispose(fn: () => MaybePromise<void>): void;
}
