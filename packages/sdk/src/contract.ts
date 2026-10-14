import type { z } from 'zod';
import { choiceOf, type Choice } from './choice.ts';
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

/** What an RPC does: `query` only reads; `mutation` (the default) may change something. */
export type RpcKind = 'query' | 'mutation';

export interface RpcDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /**
   * `query` for an RPC that only reads and is safe to repeat: clients may call it on mount, on
   * focus, on retry and after every event. Omit for a mutation.
   */
  readonly kind?: RpcKind;
  /** Omit for an RPC without input: callers pass nothing, and the input must be `undefined`. */
  readonly input?: I;
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

/** A dashboard widget. Its title, icon and component live in `definePanel`. */
export interface WidgetDef {
  /** Per-instance configuration, edited in the dashboard and validated when a preset is saved. */
  readonly config?: z.ZodObject;
}

/**
 * A secret the owner enters in the panel's Secrets card. It is a plain string and is not validated
 * beyond that: the platform rejects bad credentials itself.
 */
export interface UserSecretDef {
  readonly userSettable: true;
  /** Shown in the Secrets card. */
  readonly label: string;
  readonly description?: string;
  readonly schema?: never;
  /** One value per key (`keyed: choice(rpc)`) is specified but not built for user-settable secrets. */
  readonly keyed?: never;
}

/** A secret only the plugin reads and writes, e.g. OAuth tokens. */
export interface InternalSecretDef {
  readonly userSettable?: false;
  /** Default: a plain string. Any JSON-safe schema; the core stores the validated input as JSON. */
  readonly schema?: z.ZodType;
  /** One value per key, e.g. one token per account. Keys are 1 to 128 characters. */
  readonly keyed?: boolean;
  readonly label?: never;
  readonly description?: never;
}

export type SecretDef = UserSecretDef | InternalSecretDef;
export type SecretDefs = Readonly<Record<string, SecretDef>>;

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
  /** Settings schema. Give every field a default so a fresh install can start. */
  readonly settings?: z.ZodObject;
  /** Credentials, encrypted at rest. Names follow the member-name rule. */
  readonly secrets?: SecretDefs;
  readonly events?: Readonly<Record<string, EventDef>>;
  readonly hooks?: Readonly<Record<string, HookDef>>;
  readonly rpc?: Readonly<Record<string, RpcDef>>;
  readonly providers?: Readonly<Record<string, ProviderSlotDef>>;
  readonly widgets?: Readonly<Record<string, WidgetDef>>;
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

type UnwrapField<S> =
  S extends z.ZodDefault<infer I>
    ? UnwrapField<I>
    : S extends z.ZodOptional<infer I>
      ? UnwrapField<I>
      : S extends z.ZodNullable<infer I>
        ? UnwrapField<I>
        : S;
/** RPC names of the `choice()` fields of one form schema (distributes over unions). */
type ChoicesIn<O> =
  O extends z.ZodObject<infer Shape>
    ? { [K in keyof Shape]: UnwrapField<Shape[K]> extends Choice<infer N> ? N : never }[keyof Shape]
    : never;
type ConfigOf<D> = D extends { config: infer O } ? O : never;
type UsedChoices<C> =
  | (C extends { settings: infer S } ? ChoicesIn<S> : never)
  | (C extends { widgets: infer W } ? ChoicesIn<ConfigOf<W[keyof W]>> : never)
  | (C extends { overlays: infer O } ? ChoicesIn<ConfigOf<O[keyof O]>> : never);
/** Own RPCs a `choice()` may name: queries without input, output `Choices`, `expose.panel`. */
type ChoiceRpcs<C> = C extends { id: infer Id extends string; rpc: infer R }
  ? {
      [K in keyof R & string]: R[K] extends { input: z.ZodType }
        ? never
        : R[K] extends {
              kind: 'query';
              output: infer Out extends z.ZodType;
              expose: { panel: Role };
            }
          ? z.output<Out> extends readonly { value: string; label: string }[]
            ? `${Id}.${K}`
            : never
          : never;
    }[keyof R & string]
  : never;

/** Fails `defineContract` when a `choice()` names an RPC it may not use. */
export type CheckChoices<C extends ContractShape> = [
  Exclude<UsedChoices<C>, ChoiceRpcs<C>>,
] extends [never]
  ? unknown
  : {
      readonly 'choice() needs an own query RPC without input, with output Choices and expose.panel': Exclude<
        UsedChoices<C>,
        ChoiceRpcs<C>
      >;
    };

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MEMBER_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
// A Set, not a comparison chain: TypeScript knows only these two values can occur, so
// `no-unnecessary-condition` rejects comparing against them one by one.
const RPC_KINDS: ReadonlySet<string> = new Set<RpcKind>(['query', 'mutation']);

/**
 * Declares a plugin's public surface. Keeps literal types so names autocomplete.
 * Throws like `checkContract`.
 */
export function defineContract<const C extends ContractShape>(
  contract: C & CheckOverlays<C> & CheckChoices<C>,
): C {
  checkContract(contract);
  return contract;
}

/**
 * The runtime checks of `defineContract`: throws on malformed ids, versions, member names, RPC
 * kinds, widget ids, overlay declarations and `choice()` fields. The core runs them again when
 * it loads a plugin, because `definePlugin` accepts any object shaped like a contract.
 */
export function checkContract(shape: ContractShape): void {
  if (!ID_PATTERN.test(shape.id)) {
    throw new Error(`Invalid contract id "${shape.id}" (expected ${String(ID_PATTERN)})`);
  }
  if (!SEMVER_PATTERN.test(shape.version)) {
    throw new Error(`Invalid version "${shape.version}" in contract "${shape.id}"`);
  }
  const groups = [
    ['events', shape.events],
    ['hooks', shape.hooks],
    ['rpc', shape.rpc],
    ['providers', shape.providers],
  ] as const;
  const seen = new Map<string, string>();
  for (const [group, members] of groups) {
    for (const member of Object.keys(members ?? {})) {
      if (!MEMBER_PATTERN.test(member)) {
        throw new Error(`Invalid member name "${member}" in contract "${shape.id}"`);
      }
      const other = seen.get(member);
      if (other !== undefined) {
        throw new Error(
          `Member name "${member}" is used in both ${other} and ${group} of contract "${shape.id}"`,
        );
      }
      seen.set(member, group);
    }
  }
  for (const [member, def] of Object.entries(shape.rpc ?? {})) {
    if (def.kind !== undefined && !RPC_KINDS.has(def.kind)) {
      throw new Error(
        `Invalid kind "${def.kind}" of RPC "${member}" in contract "${shape.id}" (expected "query" or "mutation")`,
      );
    }
  }
  for (const name of Object.keys(shape.widgets ?? {})) {
    if (!ID_PATTERN.test(name)) {
      throw new Error(
        `Invalid widget id "${name}" in contract "${shape.id}" (expected ${String(ID_PATTERN)})`,
      );
    }
  }
  checkSecrets(shape);
  for (const [name, overlay] of Object.entries(shape.overlays ?? {})) {
    checkOverlay(shape, name, overlay);
  }
  checkChoices(shape);
}

/** Names follow the member-name rule; user-settable secrets are labelled plain strings. */
function checkSecrets(contract: ContractShape): void {
  for (const [name, def] of Object.entries<SecretDef>(contract.secrets ?? {})) {
    if (!MEMBER_PATTERN.test(name)) {
      throw new Error(`Invalid secret name "${name}" in contract "${contract.id}"`);
    }
    // Read as unknown: the checks exist for declarations the types would reject.
    const raw: Partial<Readonly<Record<'userSettable' | 'label' | 'schema' | 'keyed', unknown>>> =
      def;
    const where = `Secret "${name}" of contract "${contract.id}"`;
    if (raw.userSettable === true) {
      if (typeof raw.label !== 'string' || raw.label.trim() === '') {
        throw new Error(`${where} is user-settable and needs a label`);
      }
      if (raw.schema !== undefined) {
        throw new Error(`${where} is user-settable, so it is a plain string without a schema`);
      }
      if (raw.keyed !== undefined) {
        throw new Error(`${where}: keyed user-settable secrets are not supported yet`);
      }
    } else if (raw.keyed !== undefined && typeof raw.keyed !== 'boolean') {
      throw new Error(`${where}: keyed must be true or false`);
    }
  }
}

/** Each `choice()` field must name an own query RPC without input and with `expose.panel`. */
function checkChoices(contract: ContractShape): void {
  const forms: [string, z.ZodObject | undefined][] = [
    ['Settings', contract.settings],
    ...Object.entries(contract.widgets ?? {}).map(
      ([name, widget]): [string, z.ZodObject | undefined] => [`Widget "${name}"`, widget.config],
    ),
    ...Object.entries(contract.overlays ?? {}).map(
      ([name, overlay]): [string, z.ZodObject | undefined] => [`Overlay "${name}"`, overlay.config],
    ),
  ];
  for (const [form, schema] of forms) {
    for (const [field, fieldSchema] of Object.entries<z.core.$ZodType>(schema?.shape ?? {})) {
      const rpc = choiceOf(fieldSchema);
      if (rpc === undefined) continue;
      const def = rpc.startsWith(`${contract.id}.`)
        ? findMember([contract], rpc, (c) => c.rpc)
        : undefined;
      if (def?.kind !== 'query' || def.input !== undefined || def.expose?.panel === undefined) {
        throw new Error(
          `${form} of contract "${contract.id}": field "${field}" uses choice("${rpc}"), which must name an own query RPC without input and with expose.panel`,
        );
      }
    }
  }
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
