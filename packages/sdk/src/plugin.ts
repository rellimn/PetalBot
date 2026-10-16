import type { z } from 'zod';
import type { Actor, Via } from './actor.ts';
import type { ContractShape } from './contract.ts';
import type { PluginContext } from './context.ts';
import type { RpcClient } from './identity.ts';
import type { DbOptions, DbSchema, KvSchema } from './storage.ts';
import type { MaybePromise, NoMembers, OwnRpcDefs } from './type-utils.ts';

/** Second argument of every RPC implementation: who called. */
export interface RpcMeta {
  /** Id of the calling plugin, or `'client'` for calls from the panel or an overlay. */
  readonly caller: string;
  /** Set for calls from a browser: who made the call. */
  readonly client?: RpcClient;
  /** A display label of the actor (`describeActor`): a name, `'overlay'` or a plugin id. */
  readonly who: string;
  /**
   * Who caused the call: a panel user, an overlay, a chat viewer or a flow. It travels along
   * nested calls and events; a plugin acting on its own is the actor of its own calls.
   */
  readonly actor: Actor;
  /** What acted on the actor's behalf (a flow), if anything. */
  readonly via?: Via;
}

type ImplInput<D> = D extends { input: infer I extends z.ZodType } ? z.output<I> : undefined;
type ImplOutput<D> = D extends { output: infer O extends z.ZodType } ? z.input<O> : never;

/** One implementation per RPC of the own contract, as `setup` returns them. */
export type RpcImpls<Own extends ContractShape> = {
  readonly [K in keyof OwnRpcDefs<Own>]: (
    input: ImplInput<OwnRpcDefs<Own>[K]>,
    call: RpcMeta,
  ) => MaybePromise<ImplOutput<OwnRpcDefs<Own>[K]>>;
};

/** What `setup` returns: `{ rpc }` when the contract has RPCs, otherwise nothing. */
export type SetupResult<Own extends ContractShape> = keyof OwnRpcDefs<Own> extends never
  ? // `void`, not `undefined`: a parameterless `setup() {}` is typed `() => void`.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- see above
    void | { readonly rpc?: never }
  : { readonly rpc: RpcImpls<Own> };

/** Second argument of `definePlugin`. Settings are declared in the contract. */
export interface PluginOptions<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
> {
  readonly dependencies?: Deps;
  readonly optionalDependencies?: Opt;
  readonly kv?: Kv;
  readonly db?: DbOptions<NonNullable<Db>>;
  /** Runs on every start. Returns the RPC implementations; they are callable once it resolves. */
  readonly setup: (ctx: PluginContext<Own, Deps, Opt, Kv, Db>) => MaybePromise<SetupResult<Own>>;
}

export type PluginDefinition<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
> = PluginOptions<Own, Deps, Opt, Kv, Db> & { readonly contract: Own };

/** Erased form of {@link PluginDefinition} the core works with at runtime. */
export interface AnyPluginDefinition {
  readonly contract: ContractShape;
  readonly dependencies?: readonly ContractShape[];
  readonly optionalDependencies?: readonly ContractShape[];
  readonly kv?: KvSchema;
  readonly db?: { readonly schema: unknown; readonly migrations?: string };
  readonly setup: (ctx: never) => unknown;
}

/**
 * Defines a plugin's server side. The contract is a separate first argument so TypeScript fixes
 * the plugin's own types before checking `setup` (keeps literal return types intact).
 */
export function definePlugin<
  const Own extends ContractShape,
  const Deps extends readonly ContractShape[] = [],
  const Opt extends readonly ContractShape[] = [],
  const Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
>(
  contract: Own,
  options: PluginOptions<Own, Deps, Opt, Kv, Db>,
): PluginDefinition<Own, Deps, Opt, Kv, Db> {
  return { ...options, contract };
}
