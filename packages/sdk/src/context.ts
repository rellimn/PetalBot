import type { z } from 'zod';
import type { ContractShape, ProviderMethodDef, ProviderSlotDef, SecretDefs } from './contract.ts';
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

/** The secret declarations of a contract (none when it declares none). */
export type SecretsOf<C extends ContractShape> = C extends { secrets: infer S extends SecretDefs }
  ? S
  : NoMembers;

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

// Optional parts are matched with `?:` and NonNullable, so the base ProviderSlotDef keeps
// string-keyed methods while a concrete slot without a part gets none.
type MethodDefsOf<Slot> = Slot extends { methods?: infer M }
  ? NonNullable<M> extends Readonly<Record<string, ProviderMethodDef>>
    ? NonNullable<M>
    : NoMembers
  : NoMembers;
type MethodInput<D> = D extends { input: infer I extends z.ZodType } ? I : never;
type MethodOutput<D> = D extends { output: infer O extends z.ZodType } ? O : never;
type InfoSchemaOf<Slot> = Slot extends { info?: infer O }
  ? NonNullable<O> extends z.ZodObject
    ? NonNullable<O>
    : never
  : never;

/** The inbound schemas of a slot, by name (none when it declares none). */
export type InboundOf<Slot> = Slot extends { inbound?: infer I }
  ? NonNullable<I> extends Readonly<Record<string, z.ZodType>>
    ? NonNullable<I>
    : NoMembers
  : NoMembers;

/** What implementers register: every method optional. */
export type ProviderImpl<Slot extends ProviderSlotDef> = {
  readonly [M in keyof MethodDefsOf<Slot>]?: (
    input: z.output<MethodInput<MethodDefsOf<Slot>[M]>>,
  ) => Promise<z.input<MethodOutput<MethodDefsOf<Slot>[M]>>>;
};

/** The second argument of `ctx.provide`: `info` exactly when the slot declares it. */
export type ProvideOptions<Slot extends ProviderSlotDef> = ([InfoSchemaOf<Slot>] extends [never]
  ? { readonly info?: never }
  : { readonly info: z.input<InfoSchemaOf<Slot>> }) & { readonly methods?: ProviderImpl<Slot> };

/** What `ctx.provide` returns: the provider's own registration. */
export interface Provided<Slot extends ProviderSlotDef> {
  readonly key: string;
  /** Sends `payload` to the slot owner. Validated now; a bad payload throws here. */
  push<N extends keyof InboundOf<Slot> & string>(
    name: N,
    payload: z.input<InboundOf<Slot>[N]>,
  ): void;
  /** Replaces the registered info. */
  update(info: [InfoSchemaOf<Slot>] extends [never] ? never : z.input<InfoSchemaOf<Slot>>): void;
  /** Ends the registration (also done automatically when the plugin stops). */
  dispose(): void;
}

/** What the slot owner sees for one registered provider. */
export interface ProviderHandle<Slot extends ProviderSlotDef> {
  readonly key: string;
  readonly pluginId: string;
  /** The registered info (undefined for slots without info). */
  readonly info: [InfoSchemaOf<Slot>] extends [never] ? undefined : z.output<InfoSchemaOf<Slot>>;
  /** Names of implemented methods. */
  readonly methods: readonly (keyof MethodDefsOf<Slot> & string)[];
  has(method: keyof MethodDefsOf<Slot> & string): boolean;
  /**
   * Validates input and output; throws UnsupportedCapabilityError if not implemented and
   * ProviderTimeoutError when the provider takes longer than the method's timeout.
   */
  call<M extends keyof MethodDefsOf<Slot> & string>(
    method: M,
    input: z.input<MethodInput<MethodDefsOf<Slot>[M]>>,
  ): Promise<z.output<MethodOutput<MethodDefsOf<Slot>[M]>>>;
}

/** A provider of a slot was registered, updated its info, or its registration ended. */
export interface ProviderChange {
  readonly key: string;
  /** The implementing plugin. */
  readonly pluginId: string;
  /** `removed` also when the implementing plugin stopped. */
  readonly change: 'added' | 'updated' | 'removed';
}

export interface ProviderView<Slot extends ProviderSlotDef> {
  keys(): string[];
  get(key: string): ProviderHandle<Slot> | undefined;
  /** Every registered provider. */
  list(): ProviderHandle<Slot>[];
  /** Calls `listener` after a provider of this slot was added, updated or removed. Removed on stop. */
  onChange(listener: (change: ProviderChange) => void): Disposer;
  /**
   * Handles pushes named `name`, one at a time in order, with the provider's handle as of the
   * push. Pushes while no handler is registered are dropped. Removed on stop.
   */
  on<N extends keyof InboundOf<Slot> & string>(
    name: N,
    handler: (
      payload: z.output<InboundOf<Slot>[N]>,
      provider: ProviderHandle<Slot>,
    ) => MaybePromise<void>,
  ): Disposer;
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
  /** Typed from the contract's `secrets`. */
  readonly secrets: SecretsApi<SecretsOf<Own>>;
  readonly schedule: ScheduleApi;
  /** HTTP routes under `/api/p/<pluginId>/...` */
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
    options: ProvideOptions<SlotOf<ImplementableSlots<Deps, Opt>[N]>>,
  ): Provided<SlotOf<ImplementableSlots<Deps, Opt>[N]>>;

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
