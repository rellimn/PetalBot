import {
  hashKey,
  useMutation as useTanstackMutation,
  useQuery as useTanstackQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
  type UseMutationOptions,
} from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';
import type { z } from 'zod';
import type { ContractShape, EventEnvelope, Failure, NoMembers, Role } from '@petalbot/sdk';
import {
  isFailure,
  presentFailure,
  type FailurePresenter,
  type FailurePresenters,
} from '../failure.ts';
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

/** The names in `Names` whose RPC the contract declares as `kind: 'query'`. */
export type QueryRpcName<All extends ContractShape, Names extends string> = {
  [N in Names]: Member<All, N, 'rpc'> extends { kind: 'query' } ? N : never;
}[Names];
/** The names in `Names` whose RPC is a mutation (no `kind`, or `kind: 'mutation'`). */
export type MutationRpcName<All extends ContractShape, Names extends string> = Exclude<
  Names,
  QueryRpcName<All, Names>
>;

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

/**
 * How the queries of a client stay fresh, by query RPC name. Unlisted queries stay plain.
 * Without any query it is a record of `never`: an empty mapped type would be `{}`, which
 * accepts any key, so a misplaced mutation would go unnoticed.
 */
export type QueryDefinitions<All extends ContractShape, Ev extends string, Q extends string> = [
  Q,
] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [N in Q]?: QueryDefinition<All, Ev, N> };

/** Per mutation RPC: which queries to invalidate after success (default: the own contract's). */
export type MutationDefinitions<M extends string, Q extends string> = [M] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<Readonly<Record<M, { readonly invalidates?: readonly Q[] }>>>;

/** The failures the mutations in `M` return directly: what their toasts present. */
export type MutationFailure<All extends ContractShape, M extends string> = Extract<
  RpcOutput<All, M>,
  Failure
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

type FailurePresentation<Output> = [Extract<Output, Failure>] extends [never]
  ? { readonly presentFailure?: never }
  : {
      /**
       * Overrides the client's `failures` for this mutation, e.g. with text from props. Return
       * undefined to fall back to the client's presenter for the code.
       */
      readonly presentFailure?: FailurePresenter<Extract<Output, Failure>>;
    };

export type MutationOptions<Input, Output, Context = unknown> = FailurePresentation<Output> & {
  /** A toast after success (for `Result` outputs: only for `{ ok: true }`). */
  readonly success?: string | ((data: Output) => ToastInput);
  /** A failure toast: Result problems contain presentation text; rejected calls use ClientError. */
  readonly error?: string | ((problem: { readonly message: string }) => ToastInput);
} & Pick<
    UseMutationOptions<Output, ClientError, Input, Context>,
    'onSuccess' | 'onMutate' | 'onError' | 'onSettled'
  >;

// `void` lets RPCs without input be called as `mutate()` (TanStack's convention).
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- see above
type MutationInput<In> = [In] extends [undefined] ? void : In;

export interface MutationHandle<In, Out> {
  /** The RPC as a TanStack mutation: `mutate(input)`, or `mutate()` for RPCs without input. */
  useMutation<Context = unknown>(
    options?: MutationOptions<MutationInput<In>, Out, Context>,
  ): UseMutationResult<Out, ClientError, MutationInput<In>, Context>;
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
> = {
  readonly [K in ScopedKeys<C, RpcsOf<C>, Rpc>]: RpcsOf<C>[K] extends { kind: 'query' }
    ? QueryHandle<RpcInput<All, `${C['id']}.${K}`>, RpcOutput<All, `${C['id']}.${K}`>>
    : MutationHandle<RpcInput<All, `${C['id']}.${K}`>, RpcOutput<All, `${C['id']}.${K}`>>;
} & {
  readonly [K in ScopedKeys<C, EventsOf<C>, Ev>]: EventHandle<
    `${C['id']}.${K}`,
    EventPayload<All, `${C['id']}.${K}`>
  >;
};

/** `api.<contractId>.<member>`: one namespace per contract the client may use. */
export type ClientApi<All extends ContractShape, Rpc extends string, Ev extends string> = {
  readonly [Id in All['id']]: Namespace<All, Extract<All, { id: Id }>, Rpc, Ev>;
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
  readonly failures?: Readonly<Record<string, FailurePresenter<Failure> | undefined>>;
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
  /** Declared by a client of the RPC's own contract (not a dependent's). */
  readonly owner: boolean;
}

/**
 * Every query any client created, by RPC name. The choice selects and labels of the panel
 * (`useChoices` in host.ts) reuse the plugin's own definition through `useDeclaredQuery`, so
 * they stay as live as the plugin's components. The owner's latest client wins (a reloaded
 * bundle replaces its old definition, even with none); a dependent's client only fills a gap.
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
 * An RPC query by name, live with the definition registered for it (plain when none is). Not
 * part of the plugin API: only `useChoices` (host.ts) uses it, with names from `choice()`
 * metadata, which the contract checks guarantee to be queries. Plugin code uses its handles.
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
    owner: false,
  };
  return useLiveRpc(declared, name, input, options);
}

function queryHandle(
  schemas: WireSchemas,
  name: string,
  hasInput: boolean,
  definition: RuntimeQueryDefinition | undefined,
  owner: boolean,
) {
  const live: LiveBinding = {
    refreshOn: definition?.refreshOn ?? [],
    update: definition?.update ?? {},
  };
  const declared: DeclaredQuery = { schemas, live, signature: liveSignature(live), owner };
  const registered = declaredQueries.get(name);
  if (owner || !registered?.owner) declaredQueries.set(name, declared);
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

function errorToast(
  option: NonNullable<MutationOptions<unknown, unknown>['error']>,
  problem: { readonly message: string },
): ToastInput {
  return typeof option === 'string'
    ? { title: option, description: problem.message, tone: 'danger' }
    : option(problem);
}

function mutationHandle<Input, Output>(
  schemas: WireSchemas,
  name: string,
  invalidates: readonly string[],
  failures: NonNullable<RuntimeDefinition['failures']>,
) {
  function useMutation<Context>(
    options: MutationOptions<Input, Output, Context> = {},
  ): UseMutationResult<Output, ClientError, Input, Context> {
    const connection = useConnection();
    const queryClient = useQueryClient();
    return useTanstackMutation<Output, ClientError, Input, Context>({
      mutationFn: (input) => request(schemas, connection, name, input) as Promise<Output>,
      onSuccess: async (data, ...args) => {
        // Every input of each query: rpcQueryKey's prefix without the input.
        for (const query of invalidates) {
          void queryClient.invalidateQueries({ queryKey: ['petalbot', 'rpc', query] });
        }
        // Toasts
        if (isFailure(data)) {
          if (options.error !== undefined) {
            // request decoded the operation schema before this envelope guard.
            const failure = data as Extract<Output, Failure>;
            const code = failure.error.code;
            const message = presentFailure(
              failure,
              options.presentFailure,
              Object.hasOwn(failures, code) ? failures[code] : undefined,
            );
            toast(errorToast(options.error, { message }));
          }
        } else if (options.success !== undefined) {
          toast(
            typeof options.success === 'string'
              ? { title: options.success, tone: 'success' }
              : options.success(data),
          );
        }
        await options.onSuccess?.(data, ...args);
      },
      onError: async (error, ...args) => {
        if (options.error !== undefined) toast(errorToast(options.error, error));
        await options.onError?.(error, ...args);
      },
      ...(options.onSettled !== undefined && {
        onSettled: options.onSettled,
      }),
      ...(options.onMutate !== undefined && {
        onMutate: options.onMutate,
      }),
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

/** Builds `api.<contractId>.<member>` handles for the allowed members of the contracts. */
function buildClient(
  own: ContractShape,
  dependencies: readonly ContractShape[],
  allowed: Allowed,
  definition: RuntimeDefinition,
): Record<string, Record<string, object>> {
  const contracts = [own, ...dependencies];
  const schemas = wireSchemas(contracts);
  const queries = definition.queries ?? {};
  const mutations = definition.mutations ?? {};
  const failures = definition.failures ?? {};
  // The default invalidation: every query of the own contract this client can use.
  const ownQueries = Object.entries(own.rpc ?? {})
    .filter(([member, def]) => def.kind === 'query' && allowed.rpc(`${own.id}.${member}`, def))
    .map(([member]) => `${own.id}.${member}`);
  const api: Record<string, Record<string, object>> = {};
  for (const contract of contracts) {
    const namespace: Record<string, object> = {};
    for (const [member, def] of Object.entries(contract.rpc ?? {})) {
      const name = `${contract.id}.${member}`;
      if (!allowed.rpc(name, def)) continue;
      namespace[member] =
        def.kind === 'query'
          ? queryHandle(
              schemas,
              name,
              def.input !== undefined,
              Object.hasOwn(queries, name) ? queries[name] : undefined,
              contract === own,
            )
          : mutationHandle(
              schemas,
              name,
              (Object.hasOwn(mutations, name) ? mutations[name]?.invalidates : undefined) ??
                ownQueries,
              failures,
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
 * RPCs the contract declares as `kind: 'query'` get `useQuery`; all others get `useMutation`.
 * `queries` only says how queries stay fresh, `mutations` what they invalidate, `failures` how
 * the mutation toasts present each failure code.
 */
export function createPluginClient<
  const Own extends ContractShape,
  const Deps extends readonly ContractShape[] = [],
>(
  contract: Own,
  definition: {
    readonly dependencies?: Deps;
    readonly queries?: QueryDefinitions<
      Own | Deps[number],
      PanelEventName<Own | Deps[number]>,
      QueryRpcName<Own | Deps[number], PanelRpcName<Own | Deps[number]>>
    >;
    readonly mutations?: MutationDefinitions<
      MutationRpcName<Own | Deps[number], PanelRpcName<Own | Deps[number]>>,
      QueryRpcName<Own | Deps[number], PanelRpcName<Own | Deps[number]>>
    >;
    readonly failures?: FailurePresenters<
      MutationFailure<
        Own | Deps[number],
        MutationRpcName<Own | Deps[number], PanelRpcName<Own | Deps[number]>>
      >
    >;
  } = {},
): ClientApi<
  Own | Deps[number],
  PanelRpcName<Own | Deps[number]>,
  PanelEventName<Own | Deps[number]>
> {
  const allowed: Allowed = {
    rpc: (_name, def) => def.expose?.panel !== undefined,
    event: (_name, def) => def.expose?.includes('panel') === true,
  };
  return buildClient(
    contract,
    definition.dependencies ?? [],
    allowed,
    definition as RuntimeDefinition,
  ) as never;
}

/**
 * The typed client of an overlay: exactly the events and RPCs its contract declaration lists.
 * Create it once at module scope, like `createPluginClient`.
 */
export function createOverlayClient<const C extends ContractShape, const N extends OverlayName<C>>(
  contract: C,
  name: N,
  definition: {
    readonly queries?: QueryDefinitions<
      OverlayScope<C, N>,
      OverlayEventName<C, N>,
      QueryRpcName<OverlayScope<C, N>, OverlayRpcName<C, N>>
    >;
    readonly mutations?: MutationDefinitions<
      MutationRpcName<OverlayScope<C, N>, OverlayRpcName<C, N>>,
      QueryRpcName<OverlayScope<C, N>, OverlayRpcName<C, N>>
    >;
    readonly failures?: FailurePresenters<
      MutationFailure<OverlayScope<C, N>, MutationRpcName<OverlayScope<C, N>, OverlayRpcName<C, N>>>
    >;
  } = {},
): ClientApi<OverlayScope<C, N>, OverlayRpcName<C, N>, OverlayEventName<C, N>> {
  const declared = contract.overlays ?? {};
  const overlay = Object.hasOwn(declared, name) ? declared[name] : undefined;
  const rpc = new Set(overlay?.rpc ?? []);
  const events = new Set(overlay?.events ?? []);
  const allowed: Allowed = {
    rpc: (qualified) => rpc.has(qualified),
    event: (qualified) => events.has(qualified),
  };
  return buildClient(
    contract,
    overlay?.dependencies ?? [],
    allowed,
    definition as RuntimeDefinition,
  ) as never;
}
