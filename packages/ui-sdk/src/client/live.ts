import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { EventEnvelope } from '@petalbot/sdk';
import type { ReadonlyStore } from '../store.ts';
import type { ConnectionState } from './connection.ts';

export type LiveUpdate = (data: unknown, event: EventEnvelope, input: unknown) => unknown;

/** How a query stays live (untyped; `LiveOptions` in plugin-client.ts adds the types). */
export interface LiveBinding {
  readonly refreshOn: readonly string[];
  readonly update: Readonly<Record<string, LiveUpdate | undefined>>;
}

/** Where a binding gets its events and the connection status from. */
export interface LiveSources {
  readonly listen: (event: string, handler: (event: EventEnvelope) => void) => () => void;
  readonly state: ReadonlyStore<ConnectionState>;
}

interface Bound {
  users: number;
  readonly stop: () => void;
}

const bindings = new WeakMap<QueryClient, Map<string, Bound>>();

/** A stable text for the events a binding listens to; '' when it listens to none. */
export function liveSignature(live: LiveBinding): string {
  const updates = Object.keys(live.update)
    .filter((name) => live.update[name] !== undefined)
    .toSorted();
  const refreshes = [...new Set(live.refreshOn)].toSorted();
  return updates.length === 0 && refreshes.length === 0 ? '' : JSON.stringify([refreshes, updates]);
}

/**
 * Keeps one query live while at least one component shows it. All users of the query share one
 * binding: the options come from the client definition, so they are the same for every user.
 */
export function bindLiveQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  live: LiveBinding,
  sources: LiveSources,
  input: unknown,
): () => void {
  let byHash = bindings.get(queryClient);
  if (!byHash) {
    byHash = new Map();
    bindings.set(queryClient, byHash);
  }
  const map = byHash;
  const hash = hashKey(queryKey);
  let bound = map.get(hash);
  if (!bound) {
    bound = start(queryClient, queryKey, live, sources, input);
    map.set(hash, bound);
  }
  const entry = bound;
  entry.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.users -= 1;
    if (entry.users > 0) return;
    map.delete(hash);
    entry.stop();
  };
}

function start(
  queryClient: QueryClient,
  queryKey: QueryKey,
  live: LiveBinding,
  sources: LiveSources,
  input: unknown,
): Bound {
  const find = () => queryClient.getQueryCache().find({ queryKey, exact: true });
  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
  };
  // A fetch in flight may have started before the event, but cancelling it would let a busy
  // stream starve the query. Instead, refetch once after it settles.
  let dirty = false;
  let watching: (() => void) | undefined;
  const refetchAfterFetch = (): void => {
    dirty = true;
    watching ??= queryClient.getQueryCache().subscribe(() => {
      const status = find()?.state.fetchStatus;
      if (status === 'fetching' || status === 'paused') return;
      watching?.();
      watching = undefined;
      if (dirty) {
        dirty = false;
        refetch();
      }
    });
  };
  const refresh = (): void => {
    if (find()?.state.fetchStatus === 'fetching') refetchAfterFetch();
    else refetch();
  };
  const apply = (update: LiveUpdate, event: EventEnvelope): void => {
    const query = find();
    if (query?.state.data === undefined || query.state.fetchStatus !== 'idle') {
      refresh();
      return;
    }
    let next: unknown;
    try {
      next = update(query.state.data, event, input);
    } catch (error) {
      console.error(
        `PetalBot: updating ${hashKey(queryKey)} from ${event.name} failed; refetching instead`,
        error,
      );
      refetch();
      return;
    }
    queryClient.setQueryData(queryKey, next);
  };

  const stops: (() => void)[] = [];
  for (const [name, update] of Object.entries(live.update)) {
    if (update === undefined) continue;
    stops.push(
      sources.listen(name, (event) => {
        apply(update, event);
      }),
    );
  }
  for (const name of new Set(live.refreshOn)) {
    if (live.update[name] !== undefined) continue;
    stops.push(
      sources.listen(name, () => {
        refresh();
      }),
    );
  }
  let wasOpen = sources.state.get().status === 'open';
  stops.push(
    sources.state.subscribe((state) => {
      const open = state.status === 'open';
      // Events sent while the socket was down are lost. The connection re-sends its subscriptions
      // right after it reports 'open'; a microtask later the refetch goes out behind them.
      if (open && !wasOpen) {
        queueMicrotask(() => {
          refetch();
        });
      }
      wasOpen = open;
    }),
  );
  // Cached data from before: events that came while nothing was bound are lost.
  if (queryClient.getQueryData(queryKey) !== undefined) refetch();
  return {
    users: 0,
    stop: () => {
      for (const stop of stops) stop();
      watching?.();
      watching = undefined;
    },
  };
}
