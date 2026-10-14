import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { ContractShape, EventDefsOf, MergeMaps, RpcDefsOf } from '@petalbot/sdk';
import { isComponent } from './panel.ts';

type OverlaysOf<C> = C extends { overlays: infer O } ? O : never;

/** Names of the overlays a contract declares (never for a contract without overlays). */
export type OverlayName<C extends ContractShape> = [OverlaysOf<C>] extends [never]
  ? never
  : keyof OverlaysOf<C> & string;

type OverlayOf<C extends ContractShape, N extends OverlayName<C>> = OverlaysOf<C>[N];
type DepsOf<O> = O extends { dependencies: infer D extends readonly ContractShape[] }
  ? D[number]
  : never;
/** The contracts an overlay's names come from: its own and its declared dependencies. */
export type OverlayScope<C extends ContractShape, N extends OverlayName<C>> =
  C | DepsOf<OverlayOf<C, N>>;
type Listed<O, K extends 'events' | 'rpc'> =
  O extends Record<K, readonly (infer E extends string)[]> ? E : never;
type ScopeEvents<C extends ContractShape, N extends OverlayName<C>> = MergeMaps<
  EventDefsOf<OverlayScope<C, N>>
>;
type ScopeRpcs<C extends ContractShape, N extends OverlayName<C>> = MergeMaps<
  RpcDefsOf<OverlayScope<C, N>>
>;

/** The events an overlay declares, by qualified name. */
export type OverlayEvents<C extends ContractShape, N extends OverlayName<C>> = {
  [K in keyof ScopeEvents<C, N> & Listed<OverlayOf<C, N>, 'events'>]: ScopeEvents<C, N>[K];
};

/** The RPCs an overlay declares, by qualified name. */
export type OverlayRpcs<C extends ContractShape, N extends OverlayName<C>> = {
  [K in keyof ScopeRpcs<C, N> & Listed<OverlayOf<C, N>, 'rpc'>]: ScopeRpcs<C, N>[K];
};

/** Qualified names of the RPCs an overlay declares. */
export type OverlayRpcName<C extends ContractShape, N extends OverlayName<C>> = keyof OverlayRpcs<
  C,
  N
> &
  string;
/** Qualified names of the events an overlay declares. */
export type OverlayEventName<
  C extends ContractShape,
  N extends OverlayName<C>,
> = keyof OverlayEvents<C, N> & string;

/** An instance's config as the component gets it: parsed, with defaults applied. */
export type OverlayConfig<C extends ContractShape, N extends OverlayName<C>> =
  OverlayOf<C, N> extends { config: infer S extends z.ZodType } ? z.output<S> : never;

export interface OverlayProps<Config> {
  readonly config: Config;
}

export interface OverlayOptions<Config> {
  readonly component: ComponentType<OverlayProps<Config>>;
}

/** The default export of an overlay bundle. */
export interface OverlayDefinition {
  readonly kind: 'petalbot.overlay';
  readonly pluginId: string;
  readonly name: string;
  /** The declaration's config schema: the host parses the stored config with it. */
  readonly config: z.ZodObject;
  readonly component: ComponentType<OverlayProps<Readonly<Record<string, unknown>>>>;
}

/** Defines an overlay entry (`src/overlays/<name>.tsx`): `export default defineOverlay(...)`. */
export function defineOverlay<const C extends ContractShape, const N extends OverlayName<C>>(
  contract: C,
  name: N,
  options: OverlayOptions<OverlayConfig<C, N>>,
): OverlayDefinition {
  const declared = contract.overlays ?? {};
  const overlay = Object.hasOwn(declared, name) ? declared[name] : undefined;
  if (!overlay) throw new Error(`Contract "${contract.id}" declares no overlay "${name}"`);
  return {
    kind: 'petalbot.overlay',
    pluginId: contract.id,
    name,
    config: overlay.config,
    component: options.component as unknown as OverlayDefinition['component'],
  };
}

/** Validates an overlay bundle's default export; throws an Error that explains the problem. */
export function checkOverlayDefinition(
  value: unknown,
  pluginId: string,
  name: string,
): OverlayDefinition {
  const overlay = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Partial<OverlayDefinition>;
  if (overlay.kind !== 'petalbot.overlay') {
    throw new Error('The overlay bundle must default-export defineOverlay(...)');
  }
  if (overlay.pluginId !== pluginId || overlay.name !== name) {
    throw new Error(
      `The overlay bundle is "${String(overlay.pluginId)}/${String(overlay.name)}", not "${pluginId}/${name}"`,
    );
  }
  if (!isComponent(overlay.component)) throw new Error('The overlay has no component');
  if (typeof (overlay.config as { safeParse?: unknown } | undefined)?.safeParse !== 'function') {
    throw new Error('The overlay has no config schema');
  }
  return overlay as OverlayDefinition;
}
