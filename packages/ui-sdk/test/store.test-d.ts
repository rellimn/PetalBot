import { describe, expectTypeOf, it } from 'vitest';
import { createStore, shallow, useStore, type ReadonlyStore } from '../src/store.ts';

interface Counter {
  count: number;
  label: string | null;
}

const store = createStore<Counter>({ count: 0, label: null });
const view: ReadonlyStore<Counter> = store;

/** Hooks must be called in a component (rules-of-hooks); the type test only compiles it. */
function Probe() {
  expectTypeOf(useStore(store, (state) => state.count)).toEqualTypeOf<number>();
  expectTypeOf(useStore(view, (state) => ({ label: state.label }), shallow)).toEqualTypeOf<{
    label: string | null;
  }>();
  return null;
}

describe('createStore', () => {
  it('types set, get and read-only views', () => {
    store.set({ count: 1 });
    store.set((state) => ({ label: state.label === null ? 'x' : null }));
    // @ts-expect-error -- wrong value type
    store.set({ count: 'one' });
    // @ts-expect-error -- unknown key
    store.set({ other: 1 });
    expectTypeOf(store.get()).toEqualTypeOf<Counter>();
    // @ts-expect-error -- a read-only store cannot be written
    view.set({ count: 2 }); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the intended type error
    expectTypeOf(Probe).returns.toBeNull();
  });
});
