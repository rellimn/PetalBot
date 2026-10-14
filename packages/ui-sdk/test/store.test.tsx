import { act, render, screen } from '@testing-library/react';
import { Profiler, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, shallow, useStore, type ReadonlyStore } from '../src/store.ts';

interface View {
  readonly filter: string;
  readonly selected: string | null;
  readonly count: number;
}
const initial: View = { filter: 'all', selected: null, count: 0 };

/** Wraps `children` in a Profiler that counts its commits under `id`. */
function counted(renders: Map<string, number>, id: string, children: ReactNode) {
  return (
    <Profiler
      id={id}
      onRender={(profiled) => {
        renders.set(profiled, (renders.get(profiled) ?? 0) + 1);
      }}
    >
      {children}
    </Profiler>
  );
}

function fakeDevtools() {
  const connection = {
    init: vi.fn<(state: unknown) => void>(),
    send: vi.fn<(action: unknown, state: unknown) => void>(),
    subscribe: vi.fn<(listener: unknown) => void>(),
  };
  const connect = vi.fn<(options: { readonly name?: string }) => typeof connection>(
    () => connection,
  );
  return { connection, connect };
}

afterEach(() => {
  Reflect.deleteProperty(window, '__REDUX_DEVTOOLS_EXTENSION__');
  vi.restoreAllMocks();
});

describe('createStore', () => {
  it('merges, updates, resets and tells subscribers the previous state', () => {
    const store = createStore<View>(initial);
    const seen: (readonly [View, View])[] = [];
    const off = store.subscribe((state, previous) => {
      seen.push([state, previous]);
    });
    store.set({ filter: 'open' });
    store.set((state) => ({ count: state.count + 1 }));
    expect(store.get()).toEqual({ filter: 'open', selected: null, count: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.[1]).toEqual({ filter: 'open', selected: null, count: 0 });
    store.reset();
    expect(store.get()).toEqual(initial);
    expect(seen).toHaveLength(3);
    off();
    store.set({ count: 5 });
    expect(seen).toHaveLength(3);
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createStore<View>(initial);
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error('broken listener');
    });
    store.subscribe((state) => {
      seen.push(state.count);
    });
    expect(() => {
      store.set({ count: 1 });
    }).not.toThrow();
    expect(seen).toEqual([1]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('is not connected to devtools without a name or without the extension', () => {
    const { connect } = fakeDevtools();
    createStore({ a: 1 }, { name: 'petalbot/test' });
    Object.assign(window, { __REDUX_DEVTOOLS_EXTENSION__: { connect } });
    createStore({ a: 1 });
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports named stores to the Redux DevTools extension in dev builds', () => {
    const { connection, connect } = fakeDevtools();
    Object.assign(window, { __REDUX_DEVTOOLS_EXTENSION__: { connect } });
    const store = createStore({ a: 1 }, { name: 'petalbot/test' });
    expect(connect.mock.calls[0]?.[0].name).toBe('petalbot/test');
    expect(connection.init).toHaveBeenCalledWith({ a: 1 });
    store.set({ a: 2 });
    expect(connection.send.mock.calls.at(-1)?.[1]).toEqual({ a: 2 });
  });
});

describe('useStore', () => {
  it('re-renders only when the selected value changes', () => {
    const store = createStore<View>(initial);
    const renders = new Map<string, number>();
    function Filter() {
      const filter = useStore(store, (state) => state.filter);
      return <p>filter {filter}</p>;
    }
    function Selection() {
      const { filter, selected } = useStore(
        store,
        (state) => ({ filter: state.filter, selected: state.selected }),
        shallow,
      );
      return (
        <p>
          selection {filter} {selected ?? '-'}
        </p>
      );
    }
    render(
      <>
        {counted(renders, 'filter', <Filter />)}
        {counted(renders, 'selection', <Selection />)}
      </>,
    );
    const before = new Map(renders);
    act(() => {
      store.set({ count: 1 });
    });
    expect(renders).toEqual(before);
    act(() => {
      store.set({ selected: 'a' });
    });
    expect(screen.getByText('selection all a')).toBeTruthy();
    expect(renders.get('filter')).toBe(before.get('filter'));
    act(() => {
      store.set({ filter: 'open' });
    });
    expect(screen.getByText('filter open')).toBeTruthy();
    expect(screen.getByText('selection open a')).toBeTruthy();
  });

  it('follows selectors that depend on props', () => {
    const items = createStore<{ readonly map: ReadonlyMap<string, { readonly v: number }> }>({
      map: new Map([
        ['a', { v: 1 }],
        ['b', { v: 2 }],
      ]),
    });
    function Item({ id }: { readonly id: string }) {
      const item = useStore(items, (state) => state.map.get(id));
      return (
        <p>
          item {id} {item?.v ?? 'none'}
        </p>
      );
    }
    const renders = new Map<string, number>();
    const { rerender } = render(counted(renders, 'item', <Item id="a" />));
    const before = renders.get('item');
    act(() => {
      items.set((state) => ({ map: new Map(state.map).set('b', { v: 3 }) }));
    });
    expect(renders.get('item')).toBe(before);
    act(() => {
      items.set((state) => ({ map: new Map(state.map).set('a', { v: 5 }) }));
    });
    expect(screen.getByText('item a 5')).toBeTruthy();
    rerender(counted(renders, 'item', <Item id="b" />));
    expect(screen.getByText('item b 3')).toBeTruthy();
  });

  it('refuses objects that were not made by createStore', () => {
    const fake: ReadonlyStore<number> = { get: () => 1, subscribe: () => () => undefined };
    function Reader() {
      const value = useStore(fake, (state) => state);
      return <p>{value}</p>;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Reader />)).toThrow('useStore needs a store made by createStore');
  });
});
