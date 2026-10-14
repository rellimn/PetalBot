import {
  hashKey,
  useMutation as useTanstackMutation,
  useQuery as useTanstackQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';
import type { z } from 'zod';
import type { ContractShape, EventEnvelope, NoMembers, Role } from '@petalbot/sdk';
import { toast, type ToastInput } from '../components/Toaster.tsx';
import type { OverlayEventName, OverlayName, OverlayRpcName, OverlayScope } from '../overlay.ts';
import type { PetalConnection } from './connection.ts';
import { currentConnection, useConnection } from './context.tsx';
import type { ClientError } from './errors.ts';
import { bindLiveQuery, liveSignature, type LiveBinding, type LiveUpdate } from './live.ts';
import { decodeWire, wireSchemas, type WireSchemas } from './wire.ts';

// ---------------------------------------------------------------------------------------------
// Names and types
// ---------------------------------------------------------------------------------------------

type RpcsOf<C> = C extends { rpc: infer R } ? R : NoMembers;
type EventsOf<C> = C extends { events: infer E } ? E : NoMembers;
type PanelRpcKeys<C> = {
  [K in keyof RpcsOf<C> & string]: RpcsOf<C>[K] extends { expose: { panel: Role } } ? K : never;
}[keyof RpcsOf<C> & string];
type PanelEventKeys<C> = {
  [K in keyof EventsOf<C> & string]: EventsOf<C>[K] extends { expose: readonly (infer E)[] }
    ? 'panel' extends E
      ? K
      : never
    : never;
}[keyof EventsOf<C> & string];

/** Qualified names of panel-exposed RPCs of the contracts in `C` (distributes over unions). */
export type PanelRpcName<C extends ContractShape> = C extends ContractShape
  ? `${C['id']}.${PanelRpcKeys<C>}`
  : never;
/** Qualified names of panel-exposed events of the contracts in `C`. */
export type PanelEventName<C extends ContractShape> = C extends ContractShape
  ? `${C['id']}.${PanelEventKeys<C>}`
  : never;

type Member<
  All extends ContractShape,
  N extends string,
  Group extends 'rpc' | 'events',
> = N extends `${infer Id}.${infer M}`
  ? Extract<All, { id: Id }> extends infer C
    ? C extends ContractShape
      ? Group extends 'rpc'
        ? M extends keyof RpcsOf<C>
          ? RpcsOf<C>[M]
          : never
        : M extends keyof EventsOf<C>
          ? EventsOf<C>[M]
          : never
      : never
    : never
  : never;

/** What a caller passes: the RPC's input, or `undefined` for RPCs without input. */
export type RpcInput<All extends ContractShape, N extends string> =
  Member<All, N, 'rpc'> extends { input: infer I extends z.ZodType } ? z.input<I> : undefined;
/** What a caller gets: the RPC's output, decoded. */
export type RpcOutput<All extends ContractShape, N extends string> =
  Member<All, N, 'rpc'> extends { output: infer O extends z.ZodType } ? z.output<O> : never;
/** An event's payload, decoded. */
export type EventPayload<All extends ContractShape, N extends string> =
  Member<All, N, 'events'> extends { schema: infer S extends z.ZodType } ? z.output<S> : never;

/** How one query stays fresh. Declared once per client, so every component gets the same. */
export interface QueryDefinition<All extends ContractShape, Ev extends string, N extends string> {
  /** Refetch when one of these events arrives (the payload is ignored). */
  readonly refreshOn?: readonly Ev[];
  /**
   * Compute the new data from the event instead (no round trip). Runs once per cached entry of
   * this RPC; `input` is that entry's input. Return `data` unchanged when the event does not
   * concern the entry, and a new object when it does (never mutate).
   */
  readonly update?: {
    readonly [E in Ev]?: (
      data: RpcOutput<All, N>,
      event: EventEnvelope<E, EventPayload<All, E>>,
      input: RpcInput<All, N>,
    ) => RpcOutput<All, N>;
  };
}

/** Per mutating RPC: which queries to invalidate after success (default: the own contract's). */
export type MutationDefinitions<Rpc extends string, Keys extends string> = Partial<
  Readonly<Record<Rpc, { readonly invalidates?: readonly Keys[] }>>
>;

export interface QueryUseOptions {
  readonly enabled?: boolean;
  /** Poll every n milliseconds. */
  readonly refetchInterval?: number;
}

type QueryArgs<In> = [In] extends [undefined]
  ? [options?: QueryUseOptions]
  : [input: In, options?: QueryUseOptions];
type CallArgs<In> = [In] extends [undefined] ? [] : [input: In];

export interface QueryHandle<In, Out> {
  /** The RPC as a live TanStack query. */
  useQuery(...args: QueryArgs<In>): UseQueryResult<Out, ClientError>;
  /** Calls the RPC; usable outside components. */
  call(...args: CallArgs<In>): Promise<Out>;
}

export interface MutationOptions<Out> {
  /** A toast after success (for `Result` outputs: only for `{ ok: true }`). */
  readonly success?: string | ((data: Out) => ToastInput);
  /** A toast after failure, with the error's (or failed `Result`'s) message as the description. */
  readonly error?: string | ((problem: { readonly message: string }) => ToastInput);
}

export interface MutationHandle<In, Out> {
  /** The RPC as a TanStack mutation: `mutate(input)`, or `mutate()` for RPCs without input. */
  useMutation(
    options?: MutationOptions<Out>,
    // `void` lets RPCs without input be called as `mutate()` (TanStack's convention).
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- see above
  ): UseMutationResult<Out, ClientError, [In] extends [undefined] ? void : In>;
  call(...args: CallArgs<In>): Promise<Out>;
}

export interface EventHandle<N extends string, P> {
  /** Runs `handler` for every event while the component is mounted: for what *happened*. */
  useEvent(handler: (event: EventEnvelope<N, P>) => void): void;
}

type ScopedKeys<C extends ContractShape, Group, Allowed extends string> = {
  [K in keyof Group & string]: `${C['id']}.${K}` extends Allowed ? K : never;
}[keyof Group & string];

type Namespace<
  All extends ContractShape,
  C extends ContractShape,
  Rpc extends string,
  Ev extends string,
  Keys extends string,
> = {
  readonly [K in ScopedKeys<C, RpcsOf<C>, Rpc>]: `${C['id']}.${K}` extends Keys
    ? QueryHandle<RpcInput<All, `${C['id']}.${K}`>, RpcOutput<All, `${C['id']}.${K}`>>
    : MutationHandle<RpcInput<All, `${C['id']}.${K}`>, RpcOutput<All, `${C['id']}.${K}`>>;
} & {
  readonly [K in ScopedKeys<C, EventsOf<C>, Ev>]: EventHandle<
    `${C['id']}.${K}`,
    EventPayload<All, `${C['id']}.${K}`>
  >;
};

/** `api.<contractId>.<member>`: one namespace per contract the client may use. */
export type ClientApi<
  All extends ContractShape,
  Rpc extends string,
  Ev extends string,
  Keys extends string,
> = {
  readonly [Id in All['id']]: Namespace<All, Extract<All, { id: Id }>, Rpc, Ev, Keys>;
};

/** The TanStack query key of an RPC query (for invalidation). */
export function rpcQueryKey(name: string, input: unknown): readonly unknown[] {
  return ['petalbot', 'rpc', name, input];
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

interface RuntimeQueryDefinition {
  readonly refreshOn?: readonly string[];
  readonly update?: Readonly<Record<string, LiveUpdate | undefined>>;
}

interface RuntimeDefinition {
  readonly queries?: Readonly<Record<string, RuntimeQueryDefinition | undefined>>;
  readonly mutations?: Readonly<
    Record<string, { readonly invalidates?: readonly string[] } | undefined>
  >;
}

/** Which members of a contract the client may use. */
interface Allowed {
  rpc(qualified: string, def: NonNullable<ContractShape['rpc']>[string]): boolean;
  event(qualified: string, def: NonNullable<ContractShape['events']>[string]): boolean;
}

/** Every event subscription goes through here; payloads arrive decoded. */
function listen(
  schemas: WireSchemas,
  connection: PetalConnection,
  name: string,
  handler: (event: EventEnvelope) => void,
): () => void {
  return connection.subscribe(name, (event) => {
    let payload: unknown;
    try {
      payload = decodeWire(schemas.events.get(name), event.payload, `The event ${name}`);
    } catch (error) {
      console.error(`PetalBot: dropped the event ${name}`, error);
      return;
    }
    handler({ ...event, payload });
  });
}

/** Every RPC call goes through here; results arrive decoded. */
async function request(
  schemas: WireSchemas,
  connection: PetalConnection,
  name: string,
  input: unknown,
): Promise<unknown> {
  return decodeWire(
    schemas.outputs.get(name),
    await connection.call(name, input),
    `The result of ${name}`,
  );
}

/** One query's live definition, as a client declared it. */
interface DeclaredQuery {
  readonly schemas: WireSchemas;
  readonly live: LiveBinding;
  readonly signature: string;
}

/**
 * Every query any client declared, by RPC name. Generic panel UI (the dashboard's choice labels,
 * the choice select of generated forms) reuses the plugin's own definition through
 * `useDeclaredQuery`, so it stays as live as the plugin's components. The last declaration wins.
 */
const declaredQueries = new Map<string, DeclaredQuery>();

const NO_SCHEMAS: WireSchemas = { events: new Map(), outputs: new Map() };

/** The shared body of every RPC query: binds the live definition, then queries. */
function useLiveRpc(
  declared: DeclaredQuery,
  name: string,
  input: unknown,
  options: QueryUseOptions | undefined,
): UseQueryResult<unknown, ClientError> {
  const connection = useConnection();
  const queryClient = useQueryClient();
  const queryKey = rpcQueryKey(name, input);
  const hash = hashKey(queryKey);
  const enabled = options?.enabled ?? true;
  const { schemas, live, signature } = declared;
  const bind = useEffectEvent(() =>
    bindLiveQuery(
      queryClient,
      queryKey,
      live,
      {
        listen: (event, handler) => listen(schemas, connection, event, handler),
        state: connection.state,
      },
      input,
    ),
  );
  // Declared before useQuery on purpose: the subscribe frames leave before the first rpc frame,
  // so no event between the server's answer and the subscription gets lost. A disabled query
  // neither binds nor subscribes.
  useEffect(
    () => (signature === '' || !enabled ? undefined : bind()),
    [connection, queryClient, hash, enabled, signature],
  );
  return useTanstackQuery<unknown, ClientError>({
    queryKey,
    queryFn: () => request(schemas, connection, name, input),
    enabled,
    ...(options?.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
}

/**
 * An RPC query by name, live with the definition some plugin client declared for it (plain when
 * none did). For generic UI that knows only the name; plugin code uses its client's handles.
 */
export function useDeclaredQuery(
  name: string,
  input: unknown,
  options?: QueryUseOptions,
): UseQueryResult<unknown, ClientError> {
  const declared = declaredQueries.get(name) ?? {
    schemas: NO_SCHEMAS,
    live: { refreshOn: [], update: {} },
    signature: '',
  };
  return useLiveRpc(declared, name, input, options);
}

function queryHandle(
  schemas: WireSchemas,
  name: string,
  hasInput: boolean,
  definition: RuntimeQueryDefinition,
) {
  const live: LiveBinding = {
    refreshOn: definition.refreshOn ?? [],
    update: definition.update ?? {},
  };
  const declared: DeclaredQuery = { schemas, live, signature: liveSignature(live) };
  declaredQueries.set(name, declared);
  function useQuery(...args: unknown[]): UseQueryResult<unknown, ClientError> {
    const input = hasInput ? args[0] : undefined;
    const options = (hasInput ? args[1] : args[0]) as QueryUseOptions | undefined;
    return useLiveRpc(declared, name, input, options);
  }
  return {
    useQuery,
    call: (input?: unknown) => request(schemas, currentConnection(), name, input),
  };
}

/** A mutation result shaped like a failed `Result` (`{ ok: false, message }`). */
function failedResult(data: unknown): { readonly message: string } | undefined {
  return typeof data === 'object' &&
    data !== null &&
    'ok' in data &&
    data.ok === false &&
    'message' in data &&
    typeof data.message === 'string'
    ? { message: data.message }
    : undefined;
}

function errorToast(
  option: NonNullable<MutationOptions<unknown>['error']>,
  problem: { readonly message: string },
): ToastInput {
  return typeof option === 'string'
    ? { title: option, description: problem.message, tone: 'danger' }
    : option(problem);
}

function mutationHandle(schemas: WireSchemas, name: string, invalidates: readonly string[]) {
  function useMutation(
    options: MutationOptions<unknown> = {},
  ): UseMutationResult<unknown, ClientError> {
    const connection = useConnection();
    const queryClient = useQueryClient();
    return useTanstackMutation<unknown, ClientError, unknown>({
      mutationFn: (input) => request(schemas, connection, name, input),
      onSuccess: (data) => {
        // Every input of each query: rpcQueryKey's prefix without the input.
        for (const query of invalidates) {
          void queryClient.invalidateQueries({ queryKey: ['petalbot', 'rpc', query] });
        }
        const failed = failedResult(data);
        if (failed) {
          if (options.error !== undefined) toast(errorToast(options.error, failed));
          return;
        }
        if (options.success !== undefined) {
          toast(
            typeof options.success === 'string'
              ? { title: options.success, tone: 'success' }
              : options.success(data),
          );
        }
      },
      onError: (error) => {
        if (options.error !== undefined) toast(errorToast(options.error, error));
      },
    });
  }
  return {
    useMutation,
    call: (input?: unknown) => request(schemas, currentConnection(), name, input),
  };
}

function eventHandle(schemas: WireSchemas, name: string) {
  function useEvent(handler: (event: EventEnvelope) => void): void {
    const connection = useConnection();
    const onEvent = useEffectEvent(handler);
    useEffect(
      () =>
        listen(schemas, connection, name, (event) => {
          onEvent(event);
        }),
      [connection],
    );
  }
  return { useEvent };
}

/** Builds `api.<contractId>.<member>` handles for the allowed members of `contracts`. */
function buildClient(
  contracts: readonly ContractShape[],
  allowed: Allowed,
  definition: RuntimeDefinition,
): Record<string, Record<string, object>> {
  const schemas = wireSchemas(contracts);
  const queries = definition.queries ?? {};
  const mutations = definition.mutations ?? {};
  const ownQueries = Object.keys(queries).filter((name) =>
    name.startsWith(`${contracts[0]?.id ?? ''}.`),
  );
  const api: Record<string, Record<string, object>> = {};
  for (const contract of contracts) {
    const namespace: Record<string, object> = {};
    for (const [member, def] of Object.entries(contract.rpc ?? {})) {
      const name = `${contract.id}.${member}`;
      if (!allowed.rpc(name, def)) continue;
      const query = Object.hasOwn(queries, name) ? queries[name] : undefined;
      namespace[member] = query
        ? queryHandle(schemas, name, def.input !== undefined, query)
        : mutationHandle(
            schemas,
            name,
            (Object.hasOwn(mutations, name) ? mutations[name]?.invalidates : undefined) ??
              ownQueries,
          );
    }
    for (const [member, def] of Object.entries(contract.events ?? {})) {
      const name = `${contract.id}.${member}`;
      if (allowed.event(name, def)) namespace[member] = eventHandle(schemas, name);
    }
    api[contract.id] = namespace;
  }
  return api;
}

/**
 * The typed client of a plugin's panel code: `api.<contractId>.<member>` for the own contract and
 * every dependency. Create it once at module scope (the React Compiler needs stable hooks).
 * RPCs listed in `queries` get `useQuery`; all others get `useMutation`.
 */
export function createPluginClient<
  const Own extends ContractShape,
  const Deps extends readonly ContractShape[] = [],
  const Keys extends PanelRpcName<Own | Deps[number]> = never,
>(
  contract: Own,
  definition: {
    readonly dependencies?: Deps;
    readonly queries?: {
      readonly [N in Keys]: QueryDefinition<
        Own | Deps[number],
        PanelEventName<Own | Deps[number]>,
        N
      >;
    };
    readonly mutations?: MutationDefinitions<PanelRpcName<Own | Deps[number]>, Keys>;
  } = {},
): ClientApi<
  Own | Deps[number],
  PanelRpcName<Own | Deps[number]>,
  PanelEventName<Own | Deps[number]>,
  Keys
> {
  const contracts = [contract, ...(definition.dependencies ?? [])];
  const allowed: Allowed = {
    rpc: (_name, def) => def.expose?.panel !== undefined,
    event: (_name, def) => def.expose?.includes('panel') === true,
  };
  return buildClient(contracts, allowed, definition as RuntimeDefinition) as never;
}

/**
 * The typed client of an overlay: exactly the events and RPCs its contract declaration lists.
 * Create it once at module scope, like `createPluginClient`.
 */
export function createOverlayClient<
  const C extends ContractShape,
  const N extends OverlayName<C>,
  const Keys extends OverlayRpcName<C, N> = never,
>(
  contract: C,
  name: N,
  definition: {
    readonly queries?: {
      readonly [K in Keys]: QueryDefinition<OverlayScope<C, N>, OverlayEventName<C, N>, K>;
    };
    readonly mutations?: MutationDefinitions<OverlayRpcName<C, N>, Keys>;
  } = {},
): ClientApi<OverlayScope<C, N>, OverlayRpcName<C, N>, OverlayEventName<C, N>, Keys> {
  const declared = contract.overlays ?? {};
  const overlay = Object.hasOwn(declared, name) ? declared[name] : undefined;
  const rpc = new Set(overlay?.rpc ?? []);
  const events = new Set(overlay?.events ?? []);
  const allowed: Allowed = {
    rpc: (qualified) => rpc.has(qualified),
    event: (qualified) => events.has(qualified),
  };
  return buildClient(
    [contract, ...(overlay?.dependencies ?? [])],
    allowed,
    definition as RuntimeDefinition,
  ) as never;
}
