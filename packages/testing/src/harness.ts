import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { Kernel, createStorage, openDatabase, type KernelStorage } from '@petalbot/core';
import type {
  AnyPluginDefinition,
  ContractShape,
  DbSchema,
  EventDefsOf,
  EventEnvelope,
  KvSchema,
  Logger,
  MergeMaps,
  NoMembers,
  PluginDefinition,
  RpcDefsOf,
  RpcImpls,
} from '@petalbot/sdk';

type SchemaOf<D, K extends string> = D extends Record<K, infer S extends z.ZodType> ? S : never;
type DependencyEvents<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> = MergeMaps<EventDefsOf<Deps[number] | Opt[number]>>;
type OwnRpc<Own extends ContractShape> = MergeMaps<RpcDefsOf<Own>>;

/** Per dependency id: fake implementations of (some of) its RPCs. */
export type FakeDependencies<C extends ContractShape> = {
  readonly [K in C as K['id']]?: { readonly rpc?: Partial<RpcImpls<K>> };
};

export interface HarnessOptions<
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
> {
  /** Unfaked RPCs throw when called. Optional dependencies only run when listed here. */
  readonly fakes?: FakeDependencies<Deps[number] | Opt[number]>;
  /** Stored settings to start with (validated against the plugin's schema on start). */
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
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
    input: z.input<SchemaOf<OwnRpc<Own>[N], 'input'>>,
  ): Promise<z.output<SchemaOf<OwnRpc<Own>[N], 'output'>>>;
  /** Resolves when all queued events have been handled. */
  idle(): Promise<void>;
  /** Stops the caller, the plugin and the fakes. */
  stop(): Promise<void>;
}

interface Emitter {
  emit(name: string, payload: unknown): void;
}

interface Caller {
  call(name: string, input: unknown): Promise<unknown>;
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
 * fakes. Use `vi.useFakeTimers()` to control `ctx.schedule`.
 */
export async function createTestHarness<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Settings extends z.ZodObject = z.ZodObject<NoMembers>,
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
>(
  definition: PluginDefinition<Own, Deps, Opt, Settings, Kv, Db>,
  options: HarnessOptions<Deps, Opt> = {},
): Promise<TestHarness<Own, Deps, Opt>> {
  const storage = createStorage(openDatabase(':memory:'), randomBytes(32));
  const pluginId = definition.contract.id;
  if (options.settings) storage.settings.write(pluginId, options.settings);
  const kernel = new Kernel({ logger: options.logger ?? silentLogger, storage });
  const events: EventEnvelope[] = [];
  kernel.tap((event) => {
    events.push(event);
  });

  const fakes = (options.fakes ?? {}) as Readonly<
    Record<string, { readonly rpc?: Readonly<Record<string, unknown>> } | undefined>
  >;
  const emitters = new Map<string, Emitter>();
  const started: string[] = [];
  const optional = (definition.optionalDependencies ?? []).filter(
    (contract) => fakes[contract.id] !== undefined,
  );
  for (const contract of [...(definition.dependencies ?? []), ...optional]) {
    await kernel.start(
      fakeDefinition(contract, fakes[contract.id]?.rpc ?? {}, (ctx) => {
        emitters.set(contract.id, ctx);
      }),
    );
    started.push(contract.id);
  }
  await kernel.start(definition);
  started.push(pluginId);

  const caller: { ctx?: Caller } = {};
  const callerDefinition: AnyPluginDefinition = {
    contract: { id: CALLER_ID, version: '0.0.0' },
    dependencies: [definition.contract],
    setup: (ctx: Caller) => {
      caller.ctx = ctx;
    },
  };
  await kernel.start(callerDefinition);
  started.push(CALLER_ID);

  return {
    kernel,
    storage,
    events,
    emit(name, payload) {
      const owner = name.slice(0, name.indexOf('.'));
      const emitter = emitters.get(owner);
      if (!emitter) {
        throw new Error(
          `Dependency "${owner}" is not running in this harness (optional dependencies need an entry in fakes)`,
        );
      }
      emitter.emit(name, payload);
    },
    call(name, input) {
      if (!caller.ctx) return Promise.reject(new Error('The harness caller is not running'));
      return caller.ctx.call(name, input) as Promise<never>;
    },
    idle: () => kernel.idle(),
    async stop() {
      for (const id of [...started].reverse()) await kernel.stop(id);
    },
  };
}

function fakeDefinition(
  contract: ContractShape,
  fakes: Readonly<Record<string, unknown>>,
  onSetup: (ctx: Emitter) => void,
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
  return { contract, rpc, setup: onSetup };
}
