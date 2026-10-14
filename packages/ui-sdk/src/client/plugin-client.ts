import {
  hashKey,
  useMutation as useTanstackMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';
import type { z } from 'zod';
import type {
  ContractShape,
  EventDefsOf,
  EventEnvelope,
  MergeMaps,
  Role,
  RpcDefsOf,
} from '@petalbot/sdk';
import type { OverlayEvents, OverlayName, OverlayRpcs } from '../overlay.ts';
import type { PetalConnection } from './connection.ts';
import { currentConnection, useConnection } from './context.tsx';
import type { ClientError } from './errors.ts';
import { bindLiveQuery, liveSignature, type LiveBinding, type LiveUpdate } from './live.ts';
import { decodeWire, wireSchemas, type WireSchemas } from './wire.ts';

type EventsOf<C extends ContractShape> = MergeMaps<EventDefsOf<C>>;
type RpcsOf<C extends ContractShape> = MergeMaps<RpcDefsOf<C>>;

/** Events of `C` exposed to the panel, by qualified name. */
export type PanelEvents<C extends ContractShape> = {
  [
    K in keyof EventsOf<C> & string as EventsOf<C>[K] extends { expose: readonly (infer E)[] }
      ? 'panel' extends E
        ? K
        : never
      : never
  ]: EventsOf<C>[K];
};

/** RPCs of `C` with `expose.panel`, by qualified name (roles are checked by the server). */
export type PanelRpcs<C extends ContractShape> = {
  [
    K in keyof RpcsOf<C> & string as RpcsOf<C>[K] extends { expose: { panel: Role } } ? K : never
  ]: RpcsOf<C>[K];
};

type PayloadOf<D> = D extends { schema: infer S extends z.ZodType } ? z.output<S> : never;
type InputOf<D> = D extends { input: infer S extends z.ZodType } ? z.input<S> : never;
type OutputOf<D> = D extends { output: infer S extends z.ZodType } ? z.output<S> : never;

/**
 * Keeps an RPC query live. `refreshOn` refetches when one of these events arrives; `update` patches
 * the cached result from the event instead (no round trip). An event in both is handled by
 * `update`. All components showing the same query share one binding; the first one's options
 * count.
 */
export interface LiveOptions<Ev, Out> {
  readonly refreshOn?: readonly (keyof Ev & string)[];
  readonly update?: {
    readonly [N in keyof Ev & string]?: (
      data: Out,
      event: EventEnvelope<N, PayloadOf<Ev[N]>>,
    ) => Out;
  };
}

// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- default: a client without events
export interface RpcQueryOptions<Ev = Record<never, never>, Out = unknown> extends LiveOptions<
  Ev,
  Out
> {
  readonly enabled?: boolean;
  /** Poll every n milliseconds. */
  readonly refetchInterval?: number;
}

/** What `useRpc` receives at runtime (the public signature adds the types). */
interface UntypedRpcOptions {
  readonly enabled?: boolean;
  readonly refetchInterval?: number;
  readonly refreshOn?: readonly string[];
  readonly update?: Readonly<Record<string, LiveUpdate | undefined>>;
}

export interface PluginClient<Ev, Rpc> {
  readonly pluginId: string;
  /** Ids of the dependency contracts the client was created with. */
  readonly dependencies: readonly string[];
  /** Calls `handler` for every `name` event while the component is mounted. */
  useEvent<N extends keyof Ev & string>(
    name: N,
    handler: (event: EventEnvelope<N, PayloadOf<Ev[N]>>) => void,
  ): void;
  /** An RPC as a TanStack query: `data`, `isPending`, `error`, `refetch()`; live with options. */
  useRpc<N extends keyof Rpc & string>(
    name: N,
    input: InputOf<Rpc[N]>,
    options?: RpcQueryOptions<Ev, OutputOf<Rpc[N]>>,
  ): UseQueryResult<OutputOf<Rpc[N]>, ClientError>;
  /** An RPC as a TanStack mutation: `mutate(input)`, `isPending`, `data`, `error`. */
  useMutation<N extends keyof Rpc & string>(
    name: N,
  ): UseMutationResult<OutputOf<Rpc[N]>, ClientError, InputOf<Rpc[N]>>;
  /** Calls an RPC; usable outside components (event handlers, timers). */
  call<N extends keyof Rpc & string>(name: N, input: InputOf<Rpc[N]>): Promise<OutputOf<Rpc[N]>>;
}

/** The TanStack query key `useRpc` uses (for invalidation). */
export function rpcQueryKey(name: string, input: unknown): readonly unknown[] {
  return ['petalbot', 'rpc', name, input];
}

/** Every event subscription of a client goes through here; payloads arrive decoded. */
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

/** Every RPC call of a client goes through here; results arrive decoded. */
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

/** The untyped client; the public factories only add types. */
function clientFor(pluginId: string, contracts: readonly ContractShape[]) {
  const schemas: WireSchemas = wireSchemas(contracts);
  const dependencies = contracts.slice(1).map((contract) => contract.id);
  function useEvent(name: string, handler: (event: EventEnvelope) => void): void {
    const connection = useConnection();
    const onEvent = useEffectEvent(handler);
    useEffect(
      () =>
        listen(schemas, connection, name, (event) => {
          onEvent(event);
        }),
      [connection, name],
    );
  }

  function useRpc(name: string, input: unknown, options: UntypedRpcOptions = {}) {
    const connection = useConnection();
    const queryClient = useQueryClient();
    const queryKey = rpcQueryKey(name, input);
    const live: LiveBinding = { refreshOn: options.refreshOn ?? [], update: options.update ?? {} };
    const signature = liveSignature(live);
    const hash = hashKey(queryKey);
    const bind = useEffectEvent(() =>
      bindLiveQuery(queryClient, queryKey, live, {
        listen: (event, handler) => listen(schemas, connection, event, handler),
        state: connection.state,
      }),
    );
    // Declared before useQuery on purpose: the subscribe frames leave before the first rpc frame,
    // so no event between the server's answer and the subscription gets lost.
    useEffect(
      () => (signature === '' ? undefined : bind()),
      [connection, queryClient, hash, signature],
    );
    return useQuery<unknown, ClientError>({
      queryKey,
      queryFn: () => request(schemas, connection, name, input),
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.refetchInterval === undefined
        ? {}
        : { refetchInterval: options.refetchInterval }),
    });
  }

  function useMutation(name: string) {
    const connection = useConnection();
    return useTanstackMutation<unknown, ClientError, unknown>({
      mutationFn: (input) => request(schemas, connection, name, input),
    });
  }

  const call = (name: string, input: unknown): Promise<unknown> =>
    request(schemas, currentConnection(), name, input);

  return { pluginId, dependencies, useEvent, useRpc, useMutation, call };
}

/**
 * The typed client of a plugin's panel code. Create it once at module scope, not in a component:
 * the React Compiler rejects hooks taken from a hook's result.
 */
export function createPluginClient<
  const Own extends ContractShape,
  const Deps extends readonly ContractShape[] = [],
>(
  contract: Own,
  dependencies?: Deps,
): PluginClient<PanelEvents<Own | Deps[number]>, PanelRpcs<Own | Deps[number]>> {
  return clientFor(contract.id, [contract, ...(dependencies ?? [])]) as never;
}

/**
 * The typed client of an overlay: exactly the events and RPCs its contract declaration lists.
 * Create it once at module scope, like `createPluginClient`.
 */
export function createOverlayClient<const C extends ContractShape, const N extends OverlayName<C>>(
  contract: C,
  name: N,
): PluginClient<OverlayEvents<C, N>, OverlayRpcs<C, N>> {
  const declared = contract.overlays ?? {};
  const overlay = Object.hasOwn(declared, name) ? declared[name] : undefined;
  return clientFor(contract.id, [contract, ...(overlay?.dependencies ?? [])]) as never;
}
