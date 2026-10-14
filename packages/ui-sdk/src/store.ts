import { useStore as useZustandStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { createStore as createZustandStore, type StoreApi } from 'zustand/vanilla';

/** A store others may read but not write, e.g. `connection.state`. */
export interface ReadonlyStore<T> {
  /** The current state. */
  get(): T;
  /** Calls `listener` after every change; returns a function that unsubscribes. */
  subscribe(listener: (state: T, previous: T) => void): () => void;
}

/**
 * Client state shared by components and plain code. Create it at module scope and read it with
 * `useStore`. Never mutate the state: `set` replaces it.
 */
export interface Store<T extends object> extends ReadonlyStore<T> {
  /** Merges `next` into the state, one level deep. */
  set(next: Partial<T> | ((state: T) => Partial<T>)): void;
  /** Back to the initial state. */
  reset(): void;
}

export interface StoreOptions {
  /** Shows the store under this name in the Redux DevTools extension (dev builds only). */
  readonly name?: string;
}

/** Third argument of `useStore` for selectors that build a new object or array. */
export const shallow: unique symbol = Symbol('petalbot.shallow');

const apis = new WeakMap<object, StoreApi<unknown>>();

const hasDevtools = (): boolean =>
  typeof window !== 'undefined' && '__REDUX_DEVTOOLS_EXTENSION__' in window;

export function createStore<T extends object>(initial: T, options: StoreOptions = {}): Store<T> {
  const name = options.name;
  // `import.meta.env.DEV` must stay in this condition: production builds then drop the devtools
  // middleware completely (verified while planning M4s).
  const api: StoreApi<T> =
    import.meta.env.DEV && name !== undefined && hasDevtools()
      ? createZustandStore<T>()(devtools(() => initial, { name, enabled: true }))
      : createZustandStore<T>()(() => initial);
  const store: Store<T> = {
    get: () => api.getState(),
    set: (next) => {
      api.setState(next);
    },
    // Each listener is isolated: one that throws must not stop the others (Zustand doesn't).
    subscribe: (listener) =>
      api.subscribe((state, previous) => {
        try {
          listener(state, previous);
        } catch (error) {
          console.error('PetalBot: a store listener failed', error);
        }
      }),
    reset: () => {
      api.setState(api.getInitialState(), true);
    },
  };
  apis.set(store, api);
  return store;
}

function apiOf<T>(store: ReadonlyStore<T>): StoreApi<T> {
  const api = apis.get(store);
  if (!api) throw new Error('PetalBot: useStore needs a store made by createStore');
  return api as StoreApi<T>;
}

/**
 * Reads `selector(state)` and re-renders only when that value changes (`Object.is`, or one level
 * deep with `shallow`). A selector that builds a new object or array needs `shallow`.
 */
export function useStore<T, U>(
  store: ReadonlyStore<T>,
  selector: (state: T) => U,
  equality?: typeof shallow,
): U {
  const shallowSelector = useShallow(selector);
  return useZustandStore(apiOf(store), equality === shallow ? shallowSelector : selector);
}
