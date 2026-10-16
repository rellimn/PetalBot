import type { z } from 'zod';
import type { ContractShape, EventDef, HookDef, ProviderSlotDef, RpcDef } from './contract.ts';

export type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

/** True for a union of two or more distinct types. */
export type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;

/** Merges a union of name->def maps into one map; `never` becomes `{}`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` = a map with no members
export type MergeMaps<U> = [U] extends [never] ? {} : UnionToIntersection<U>;

type Qualify<Id extends string, M> = { [K in keyof M & string as `${Id}.${K}`]: M[K] };

/** `{ 'quotes.added': EventDef }` for one contract (distributes over unions). */
export type EventDefsOf<C extends ContractShape> = C extends {
  id: infer Id extends string;
  events: infer E extends Readonly<Record<string, EventDef>>;
}
  ? Qualify<Id, E>
  : never;

export type HookDefsOf<C extends ContractShape> = C extends {
  id: infer Id extends string;
  hooks: infer H extends Readonly<Record<string, HookDef>>;
}
  ? Qualify<Id, H>
  : never;

export type RpcDefsOf<C extends ContractShape> = C extends {
  id: infer Id extends string;
  rpc: infer R extends Readonly<Record<string, RpcDef>>;
}
  ? Qualify<Id, R>
  : never;

export type ProviderSlotsOf<C extends ContractShape> = C extends {
  id: infer Id extends string;
  providers: infer P extends Readonly<Record<string, ProviderSlotDef>>;
}
  ? Qualify<Id, P>
  : never;

/** Short-name rpc defs of a single contract, e.g. `{ list: RpcDef }`. */
export type OwnRpcDefs<C extends ContractShape> = C extends {
  rpc: infer R extends Readonly<Record<string, RpcDef>>;
}
  ? R
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` = no RPCs
    {};

/** The arguments that carry an RPC's input: `[input]`, or `[input?]` for RPCs without input. */
export type RpcInputArgs<D> = D extends { input: infer I extends z.ZodType }
  ? [input: z.input<I>]
  : [input?: undefined];

export type MaybePromise<T> = T | Promise<T>;

export type Disposer = () => void;

/** A map type with no members; the "nothing declared" default for settings, kv and so on. */
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty on purpose
export type NoMembers = Record<never, never>;
