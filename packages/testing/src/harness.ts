import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { z } from 'zod';
import { Kernel, createStorage, openDatabase, type KernelStorage } from '@petalbot/core';
import type {
  AnyPluginDefinition,
  ContractShape,
  DbSchema,
  EventDefsOf,
  EventEnvelope,
  ImplementableSlots,
  InboundOf,
  KeyedSecretNames,
  KvSchema,
  Logger,
  MergeMaps,
  NoMembers,
  OwnedSlots,
  PluginDefinition,
  ProvideOptions,
  Provided,
  ProviderHandle,
  ProviderSlotDef,
  ProviderView,
  RpcDefsOf,
  RpcImpls,
  RpcInputArgs,
  SecretSchemaOf,
  SecretsOf,
  SettingsOf,
  SingleSecretNames,
} from '@petalbot/sdk';

type SchemaOf<D, K extends string> = D extends Record<K, infer S extends z.ZodType> ? S : never;
type DependencyEvents<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<EventDefsOf<Deps[number] | Opt[number]>>;
type OwnRpc<Own extends ContractShape> = MergeMaps<RpcDefsOf<Own>>;
type SlotOf<D> = D extends ProviderSlotDef ? D : never;
type OwnSlot<Own extends ContractShape, N> = SlotOf<OwnedSlots<Own>[N & keyof OwnedSlots<Own>]>;
type DependencySlot<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  N,
> = SlotOf<ImplementableSlots<Deps, Opt>[N & keyof ImplementableSlots<Deps, Opt>]>;
type SecretValue<Own extends ContractShape, N> = z.input<
  SecretSchemaOf<SecretsOf<Own>[N & keyof SecretsOf<Own>]>
>;

/** Per own provider slot: fake providers by key, registered before the plugin starts. */
export type FakeProviders<Own extends ContractShape> = {
  readonly [N in keyof OwnedSlots<Own> & string]?: Readonly<
    Record<string, ProvideOptions<OwnSlot<Own, N>>>
  >;
};

/** One push a provider made, as the slot owner received it. */
export type Pushed<Slot extends ProviderSlotDef> = {
  readonly [K in keyof InboundOf<Slot> & string]: {
    readonly name: K;
    readonly payload: z.output<InboundOf<Slot>[K]>;
  };
}[keyof InboundOf<Slot> & string];

/** Values to start with per declared secret; keyed secrets take `{ [key]: value }`. */
export type HarnessSecrets<Own extends ContractShape> = {
  readonly [N in SingleSecretNames<SecretsOf<Own>>]?: SecretValue<Own, N>;
} & {
  readonly [N in KeyedSecretNames<SecretsOf<Own>>]?: Readonly<Record<string, SecretValue<Own, N>>>;
};

/** Per dependency id: fake implementations of (some of) its RPCs. */
export type FakeDependencies<C extends ContractShape> = {
  readonly [K in C as K['id']]?: { readonly rpc?: Partial<RpcImpls<K>> };
};

export interface HarnessOptions<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> {
  /** Unfaked RPCs throw when called. Optional dependencies only run when listed here. */
  readonly fakes?: FakeDependencies<Deps[number] | Opt[number]>;
  /** Stored settings to start with (validated against the contract's settings on start). */
  readonly settings?: z.input<SettingsOf<Own>>;
  /** Stored secrets to start with (validated against the contract's declarations). */
  readonly secrets?: HarnessSecrets<Own>;
  /** Fake providers for the plugin's own slots, registered before it starts. */
  readonly providers?: FakeProviders<Own>;
  /** Base of `ctx.http.url`. Default `http://localhost:8080`. */
  readonly publicUrl?: string;
  readonly logger?: Logger;
  /**
   * The plugin folder, for `db` migrations. Default: the nearest folder above the running test
   * file whose package.json has a `petalbot` field.
   */
  readonly dir?: string;
}

export interface TestHarness<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> {
  readonly kernel: Kernel;
  readonly storage: KernelStorage;
  /** Every event emitted so far (fakes and plugin), in order. */
  readonly events: readonly EventEnvelope[];
  /** Emits a dependency's event as if that dependency had emitted it. */
  emit<N extends keyof DependencyEvents<Deps, Opt> & string>(
    name: N,
    payload: z.input<SchemaOf<DependencyEvents<Deps, Opt>[N], 'schema'>>,
  ): void;
  /** Calls one of the plugin's own RPCs the way another plugin would. */
  call<N extends keyof OwnRpc<Own> & string>(
    name: N,
    ...args: RpcInputArgs<OwnRpc<Own>[N]>
  ): Promise<z.output<SchemaOf<OwnRpc<Own>[N], 'output'>>>;
  /** Merges `patch` into the stored settings, as the panel does, and notifies the plugin. */
  updateSettings(patch: Partial<z.input<SettingsOf<Own>>>): Promise<z.output<SettingsOf<Own>>>;
  /**
   * Stores a secret and calls the plugin's `onChange` listeners. User-settable values are written
   * as the panel writes them: trimmed, and deleted when empty.
   */
  setSecret<N extends SingleSecretNames<SecretsOf<Own>>>(
    name: N,
    value: SecretValue<Own, N>,
  ): Promise<void>;
  setSecret<N extends KeyedSecretNames<SecretsOf<Own>>>(
    name: N,
    key: string,
    value: SecretValue<Own, N>,
  ): Promise<void>;
  /** Registers a fake provider for an own slot; push through it, `dispose()` removes it. */
  addProvider<N extends keyof OwnedSlots<Own> & string>(
    slot: N,
    key: string,
    options: ProvideOptions<OwnSlot<Own, N>>,
  ): Provided<OwnSlot<Own, N>>;
  /** The handle the slot owner sees for the plugin's provider `key` in a dependency's slot. */
  provider<N extends keyof ImplementableSlots<Deps, Opt> & string>(
    slot: N,
    key: string,
  ): ProviderHandle<DependencySlot<Deps, Opt, N>> | undefined;
  /** What the plugin pushed as provider `key` into a dependency's slot, in order (after `idle()`). */
  pushed<N extends keyof ImplementableSlots<Deps, Opt> & string>(
    slot: N,
    key: string,
  ): readonly Pushed<DependencySlot<Deps, Opt, N>>[];
  /** Resolves when all queued events and pushes have been handled. */
  idle(): Promise<void>;
  /** Stops the caller, the plugin and the fakes. */
  stop(): Promise<void>;
}

interface FakeContext {
  emit(name: string, payload: unknown): void;
  providers(slot: string): ProviderView<ProviderSlotDef>;
}

interface CallerContext {
  call(name: string, input: unknown): Promise<unknown>;
  provide(slot: string, key: string, options: object): Provided<ProviderSlotDef>;
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const CALLER_ID = 'petalbot-test-caller';

/**
 * Runs `definition` in a real Kernel on an in-memory database, with its dependencies replaced by
 * fakes and its own provider slots optionally filled with fake providers. Use
 * `vi.useFakeTimers()` to control `ctx.schedule`.
 */
export async function createTestHarness<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
>(
  definition: PluginDefinition<Own, Deps, Opt, Kv, Db>,
  options: HarnessOptions<Own, Deps, Opt> = {},
): Promise<TestHarness<Own, Deps, Opt>> {
  const storage = createStorage(openDatabase(':memory:'), randomBytes(32));
  const pluginId = definition.contract.id;
  if (options.settings) storage.settings.write(pluginId, options.settings);
  const kernel = new Kernel({
    logger: options.logger ?? silentLogger,
    storage,
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  });
  const events: EventEnvelope[] = [];
  kernel.tap((event) => {
    events.push(event);
  });

  const fakes = (options.fakes ?? {}) as Readonly<
    Record<string, { readonly rpc?: Readonly<Record<string, unknown>> } | undefined>
  >;
  const fakeContexts = new Map<string, FakeContext>();
  /** Pushes into the fakes' slots, by `<slot> <key>`. */
  const pushes = new Map<string, { readonly name: string; readonly payload: unknown }[]>();
  const record = (slot: string, key: string, name: string, payload: unknown) => {
    const id = `${slot} ${key}`;
    pushes.set(id, [...(pushes.get(id) ?? []), { name, payload }]);
  };
  const started: string[] = [];
  const optional = (definition.optionalDependencies ?? []).filter(
    (contract) => fakes[contract.id] !== undefined,
  );
  for (const contract of [...(definition.dependencies ?? []), ...optional]) {
    await kernel.start(
      fakeDefinition(contract, fakes[contract.id]?.rpc ?? {}, (ctx) => {
        fakeContexts.set(contract.id, ctx);
        // Record what providers push into the fake's slots.
        for (const [member, slot] of Object.entries(contract.providers ?? {})) {
          const name = `${contract.id}.${member}`;
          for (const inbound of Object.keys(slot.inbound ?? {})) {
            ctx.providers(name).on(inbound, (payload, provider) => {
              record(name, provider.key, inbound, payload);
            });
          }
        }
      }),
    );
    started.push(contract.id);
  }

  // The caller is an optional dependent of the plugin, started first: it registers the fake
  // providers before the plugin's setup runs, and calls the plugin's RPCs from the same plugin.
  const caller: { ctx?: CallerContext } = {};
  const fakeProviders = Object.entries(
    (options.providers ?? {}) as Readonly<Record<string, Readonly<Record<string, object>>>>,
  );
  const callerDefinition: AnyPluginDefinition = {
    contract: { id: CALLER_ID, version: '0.0.0' },
    optionalDependencies: [definition.contract],
    setup: (ctx: CallerContext) => {
      caller.ctx = ctx;
      for (const [slot, impls] of fakeProviders) {
        for (const [key, impl] of Object.entries(impls)) ctx.provide(slot, key, impl);
      }
    },
  };
  await kernel.start(callerDefinition);
  started.push(CALLER_ID);

  const secrets = kernel.secrets(definition);
  for (const [name, seed] of Object.entries(options.secrets ?? {})) {
    if (secrets.def(name).keyed === true) {
      for (const [key, value] of Object.entries(seed as Readonly<Record<string, unknown>>)) {
        await secrets.set(name, key, value);
      }
    } else {
      await secrets.set(name, undefined, seed);
    }
  }

  const dir = options.dir ?? pluginDirOfRunningTest();
  if (definition.db !== undefined && dir === undefined) {
    throw new Error(
      `createTestHarness: plugin "${pluginId}" declares db; pass { dir } with its folder`,
    );
  }
  await kernel.start(definition, dir === undefined ? {} : { dir });
  started.push(pluginId);

  const ownerContext = (name: string): FakeContext => {
    const owner = name.slice(0, name.indexOf('.'));
    const context = fakeContexts.get(owner);
    if (!context) {
      throw new Error(
        `Dependency "${owner}" is not running in this harness (optional dependencies need an entry in fakes)`,
      );
    }
    return context;
  };
  const callerContext = (): CallerContext => {
    if (!caller.ctx) throw new Error('The harness caller is not running');
    return caller.ctx;
  };

  return {
    kernel,
    storage,
    events,
    emit(name, payload) {
      ownerContext(name).emit(name, payload);
    },
    call(name, ...args) {
      if (!caller.ctx) return Promise.reject(new Error('The harness caller is not running'));
      return caller.ctx.call(name, args[0]) as Promise<never>;
    },
    updateSettings: (patch) => kernel.updateSettings(definition, patch) as Promise<never>,
    async setSecret(name: string, ...args: readonly unknown[]) {
      const def = secrets.def(name);
      if (def.keyed === true) await secrets.set(name, args[0], args[1]);
      // User-settable secrets go through the panel's path: trimmed, deleted when empty.
      else if (def.userSettable === true) await secrets.setUserValue(name, String(args[0]));
      else await secrets.set(name, undefined, args[0]);
    },
    addProvider: (slot, key, provideOptions) => callerContext().provide(slot, key, provideOptions),
    pushed: (slot, key) => (pushes.get(`${slot} ${key}`) ?? []) as never,
    provider: (slot, key) => ownerContext(slot).providers(slot).get(key),
    idle: () => kernel.idle(),
    async stop() {
      for (const id of [...started].reverse()) await kernel.stop(id);
    },
  };
}

function fakeDefinition(
  contract: ContractShape,
  fakes: Readonly<Record<string, unknown>>,
  onSetup: (ctx: FakeContext) => void,
): AnyPluginDefinition {
  const rpc = Object.fromEntries(
    Object.keys(contract.rpc ?? {}).map((member) => {
      const fake = fakes[member];
      const handler =
        typeof fake === 'function'
          ? (fake as (input: never) => unknown)
          : () => {
              throw new Error(`RPC "${contract.id}.${member}" is not faked in this harness`);
            };
      return [member, handler];
    }),
  );
  return {
    contract,
    setup: (ctx: FakeContext) => {
      onSetup(ctx);
      return { rpc };
    },
  };
}

/** The plugin folder of the test file Vitest is running, if one can be found. */
function pluginDirOfRunningTest(): string | undefined {
  const testPath = expect.getState().testPath;
  return testPath === undefined ? undefined : findPluginDir(dirname(testPath));
}

/** The nearest folder at or above `from` whose package.json has a `petalbot` field. */
function findPluginDir(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && isPluginManifest(readFileSync(manifest, 'utf8'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function isPluginManifest(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && 'petalbot' in parsed;
  } catch {
    return false;
  }
}
