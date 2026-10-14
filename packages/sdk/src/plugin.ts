import type { z } from 'zod';
import type { ContractShape } from './contract.ts';
import type { PluginContext } from './context.ts';
import type { RpcClient } from './identity.ts';
import type { DbSchema, KvSchema } from './storage.ts';
import type { MaybePromise, NoMembers, OwnRpcDefs } from './type-utils.ts';

export interface RpcMeta {
  /** Id of the calling plugin, or `'client'` for calls from the panel or an overlay. */
  readonly caller: string;
  /** Set for calls from a browser: who made the call. */
  readonly client?: RpcClient;
}

/** Second argument of an RPC implementation: who called, plus the plugin's own ctx. */
export type RpcCall<Ctx> = RpcMeta & { readonly ctx: Ctx };

export type RpcImpls<Own extends ContractShape, Ctx = unknown> = {
  readonly [K in keyof OwnRpcDefs<Own>]: OwnRpcDefs<Own>[K] extends {
    input: infer I extends z.ZodType;
    output: infer O extends z.ZodType;
  }
    ? (input: z.output<I>, meta: RpcCall<Ctx>) => MaybePromise<z.input<O>>
    : never;
};

type RpcField<Own extends ContractShape, Ctx> = keyof OwnRpcDefs<Own> extends never
  ? { readonly rpc?: never }
  : { readonly rpc: RpcImpls<Own, Ctx> };

/** Second argument of `definePlugin`. */
export type PluginOptions<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Settings extends z.ZodObject = z.ZodObject<NoMembers>,
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
> = {
  readonly dependencies?: Deps;
  readonly optionalDependencies?: Opt;
  /** Settings schema. Give every field a default so a fresh install can start. */
  readonly settings?: Settings;
  readonly kv?: Kv;
  readonly db?: { readonly schema: Db; readonly migrationsFolder: string };
  readonly setup: (ctx: PluginContext<Own, Deps, Opt, Settings, Kv, Db>) => MaybePromise<void>;
} & RpcField<Own, PluginContext<Own, Deps, Opt, Settings, Kv, Db>>;

export type PluginDefinition<
  Own extends ContractShape,
  Deps extends readonly ContractShape[],
  Opt extends readonly ContractShape[],
  Settings extends z.ZodObject = z.ZodObject<NoMembers>,
  Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
> = PluginOptions<Own, Deps, Opt, Settings, Kv, Db> & { readonly contract: Own };

/** Erased form of {@link PluginDefinition} the core works with at runtime. */
export interface AnyPluginDefinition {
  readonly contract: ContractShape;
  readonly dependencies?: readonly ContractShape[];
  readonly optionalDependencies?: readonly ContractShape[];
  readonly settings?: z.ZodObject;
  readonly kv?: KvSchema;
  readonly db?: { readonly schema: unknown; readonly migrationsFolder: string };
  readonly setup: (ctx: never) => MaybePromise<void>;
  readonly rpc?: Readonly<Record<string, (input: never, meta: never) => unknown>>;
}

/**
 * Defines a plugin's server side. The contract is a separate first argument so TypeScript fixes
 * the plugin's own types before checking `rpc` and `setup` (keeps literal return types intact).
 */
export function definePlugin<
  const Own extends ContractShape,
  const Deps extends readonly ContractShape[] = [],
  const Opt extends readonly ContractShape[] = [],
  Settings extends z.ZodObject = z.ZodObject<NoMembers>,
  const Kv extends KvSchema = NoMembers,
  Db extends DbSchema | undefined = undefined,
>(
  contract: Own,
  options: PluginOptions<Own, Deps, Opt, Settings, Kv, Db>,
): PluginDefinition<Own, Deps, Opt, Settings, Kv, Db> {
  return { ...options, contract };
}
