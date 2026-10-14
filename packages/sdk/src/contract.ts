import type { z } from 'zod';
import type { EventDefsOf, MergeMaps, RpcDefsOf } from './type-utils.ts';

export type Role = 'owner' | 'mod';
export type ClientKind = 'panel' | 'overlay';

export interface EventDef<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly expose?: readonly ClientKind[];
}

export interface HookDef<S extends z.ZodType = z.ZodType> {
  readonly input: S;
  /** When true, a throwing or timed-out handler vetoes instead of being skipped. */
  readonly failClosed?: boolean;
}

export interface RpcDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly input: I;
  readonly output: O;
  readonly expose?: { readonly panel?: Role; readonly overlay?: boolean };
}

export interface ProviderMethodDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly input: I;
  readonly output: O;
}

export type ProviderSlotDef = Readonly<Record<string, ProviderMethodDef>>;

/**
 * An overlay's scope and instance config. It lives in the contract because the server
 * enforces it but never runs the overlay's browser bundle.
 */
export interface OverlayDef {
  /** Contracts whose events and RPCs the overlay uses besides the own contract. */
  readonly dependencies?: readonly ContractShape[];
  /** Per-instance configuration, validated when an instance is created or updated. */
  readonly config: z.ZodObject;
  /** Qualified event names the overlay may subscribe to. Each must be exposed to `overlay`. */
  readonly events: readonly string[];
  /** Qualified RPC names the overlay may call. Each must have `expose.overlay: true`. */
  readonly rpc: readonly string[];
}

export interface ContractShape {
  readonly id: string;
  readonly version: string;
  readonly events?: Readonly<Record<string, EventDef>>;
  readonly hooks?: Readonly<Record<string, HookDef>>;
  readonly rpc?: Readonly<Record<string, RpcDef>>;
  readonly providers?: Readonly<Record<string, ProviderSlotDef>>;
  readonly overlays?: Readonly<Record<string, OverlayDef>>;
}

type OverlayDepsOf<O> = O extends { dependencies: infer D extends readonly ContractShape[] }
  ? D[number]
  : never;
type EventsOf<Own extends ContractShape, Dep extends ContractShape> = MergeMaps<
  EventDefsOf<Own | Dep>
>;
type RpcOf<Own extends ContractShape, Dep extends ContractShape> = MergeMaps<RpcDefsOf<Own | Dep>>;

/** Qualified names of events from `Own` and `Dep` that are exposed to overlays. */
export type OverlayEventNames<Own extends ContractShape, Dep extends ContractShape> = {
  [K in keyof EventsOf<Own, Dep> & string]: EventsOf<Own, Dep>[K] extends {
    expose: readonly (infer E extends ClientKind)[];
  }
    ? 'overlay' extends E
      ? K
      : never
    : never;
}[keyof EventsOf<Own, Dep> & string];

/** Qualified names of RPCs from `Own` and `Dep` with `expose.overlay: true`. */
export type OverlayRpcNames<Own extends ContractShape, Dep extends ContractShape> = {
  [K in keyof RpcOf<Own, Dep> & string]: RpcOf<Own, Dep>[K] extends { expose: { overlay: true } }
    ? K
    : never;
}[keyof RpcOf<Own, Dep> & string];

/** Restricts each overlay's `events` and `rpc` to exposed names of the own contract and its dependencies. */
export type CheckOverlays<C extends ContractShape> = C extends {
  overlays: infer O extends Readonly<Record<string, OverlayDef>>;
}
  ? {
      readonly overlays: {
        readonly [K in keyof O]: {
          readonly events: readonly OverlayEventNames<C, OverlayDepsOf<O[K]>>[];
          readonly rpc: readonly OverlayRpcNames<C, OverlayDepsOf<O[K]>>[];
        };
      };
    }
  : unknown;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MEMBER_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Declares a plugin's public surface. Keeps literal types so names autocomplete.
 * Throws on malformed ids, versions, member names or overlay declarations.
 */
export function defineContract<const C extends ContractShape>(contract: C & CheckOverlays<C>): C {
  const shape: ContractShape = contract;
  if (!ID_PATTERN.test(shape.id)) {
    throw new Error(`Invalid contract id "${shape.id}" (expected ${String(ID_PATTERN)})`);
  }
  if (!SEMVER_PATTERN.test(shape.version)) {
    throw new Error(`Invalid version "${shape.version}" in contract "${shape.id}"`);
  }
  const groups = [shape.events, shape.hooks, shape.rpc, shape.providers];
  for (const group of groups) {
    for (const member of Object.keys(group ?? {})) {
      if (!MEMBER_PATTERN.test(member)) {
        throw new Error(`Invalid member name "${member}" in contract "${shape.id}"`);
      }
    }
  }
  for (const [name, overlay] of Object.entries(shape.overlays ?? {})) {
    checkOverlay(shape, name, overlay);
  }
  return contract;
}

function checkOverlay(contract: ContractShape, name: string, overlay: OverlayDef): void {
  if (!ID_PATTERN.test(name)) {
    throw new Error(
      `Invalid overlay name "${name}" in contract "${contract.id}" (expected ${String(ID_PATTERN)})`,
    );
  }
  const where = `Overlay "${name}" of contract "${contract.id}"`;
  const sources = [contract, ...(overlay.dependencies ?? [])];
  for (const event of overlay.events) {
    const def = findMember(sources, event, (c) => c.events);
    if (!def?.expose?.includes('overlay')) {
      throw new Error(`${where} lists "${event}", which is not an event exposed to overlays`);
    }
  }
  for (const rpc of overlay.rpc) {
    const def = findMember(sources, rpc, (c) => c.rpc);
    if (def?.expose?.overlay !== true) {
      throw new Error(`${where} lists "${rpc}", which is not an RPC exposed to overlays`);
    }
  }
}

function findMember<D>(
  sources: readonly ContractShape[],
  qualified: string,
  group: (contract: ContractShape) => Readonly<Record<string, D>> | undefined,
): D | undefined {
  const dot = qualified.indexOf('.');
  if (dot <= 0) return undefined;
  const owner = sources.find((contract) => contract.id === qualified.slice(0, dot));
  const members = owner ? group(owner) : undefined;
  const member = qualified.slice(dot + 1);
  return members && Object.hasOwn(members, member) ? members[member] : undefined;
}
