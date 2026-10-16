import type { UseMutationResult } from '@tanstack/react-query';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Choices, Result, defineContract, defineFailure } from '@petalbot/sdk';
import type { ClientError } from '../src/client/errors.ts';
import { createPluginClient } from '../src/client/plugin-client.ts';

const counterNotFound = defineFailure({
  code: 'counter-not-found',
  reason: 'not-found',
  details: z.object({ counterId: z.string() }),
});
const Counter = z.object({ id: z.string(), name: z.string(), value: z.number().int() });
const Ref = z.object({ counter: z.string() });
const counter = defineContract({
  id: 'counter',
  version: '2.0.0',
  events: {
    changed: {
      schema: z.object({ counter: z.string(), value: z.number(), by: z.string() }),
      expose: ['panel', 'overlay'],
    },
    listChanged: { schema: z.object({}), expose: ['panel'] },
    internal: { schema: z.object({}) },
  },
  rpc: {
    list: { kind: 'query', output: z.array(Counter), expose: { panel: 'mod' } },
    options: { kind: 'query', output: Choices, expose: { panel: 'mod' } },
    get: {
      kind: 'query',
      input: Ref,
      output: Counter.nullable(),
      expose: { panel: 'mod', overlay: true },
    },
    increment: {
      input: Ref,
      output: Result(z.object({ counter: Counter }), [counterNotFound]),
      expose: { panel: 'mod' },
    },
    reset: {
      kind: 'mutation',
      input: Ref,
      output: Result(z.object({ counter: Counter }), [counterNotFound]),
      expose: { panel: 'mod' },
    },
    create: { input: z.object({ name: z.string() }), output: Counter, expose: { panel: 'owner' } },
    clear: { output: z.number(), expose: { panel: 'owner' } },
    done: { output: Result(z.object({}), []), expose: { panel: 'mod' } },
    hidden: { kind: 'query', output: z.string() },
  },
});
const chat = defineContract({
  id: 'chat',
  version: '1.0.0',
  events: { message: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: {
    recent: { kind: 'query', output: z.array(z.string()), expose: { panel: 'mod' } },
    send: {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string() }),
      expose: { panel: 'mod' },
    },
  },
});

interface CounterRow {
  id: string;
  name: string;
  value: number;
}

const api = createPluginClient(counter, {
  dependencies: [chat],
  queries: {
    'counter.list': { refreshOn: ['counter.listChanged'] },
    'counter.get': {
      update: {
        'counter.changed': (data, event, input) => {
          expectTypeOf(data).toEqualTypeOf<CounterRow | null>();
          expectTypeOf(event.payload).toEqualTypeOf<{
            counter: string;
            value: number;
            by: string;
          }>();
          expectTypeOf(input).toEqualTypeOf<{ counter: string }>();
          return data?.id === event.payload.counter
            ? { ...data, value: event.payload.value }
            : data;
        },
      },
    },
    'chat.recent': { update: { 'chat.message': (list, event) => [...list, event.payload.text] } },
  },
  mutations: { 'counter.create': { invalidates: ['counter.list', 'chat.recent'] } },
});

/** Hooks must be called in a component; type tests only need it to compile. */
export function Uses() {
  const list = api.counter.list.useQuery();
  expectTypeOf(list.data).toEqualTypeOf<CounterRow[] | undefined>();
  expectTypeOf(list.error).toEqualTypeOf<ClientError | null>();
  api.counter.list.useQuery({ enabled: false });
  const one = api.counter.get.useQuery({ counter: 'a' }, { refetchInterval: 1000 });
  expectTypeOf(one.data).toEqualTypeOf<CounterRow | null | undefined>();
  // A query without a definition is a plain query.
  expectTypeOf(api.counter.options.useQuery().data).toEqualTypeOf<
    { value: string; label: string }[] | undefined
  >();
  expectTypeOf(api.chat.recent.useQuery().data).toEqualTypeOf<string[] | undefined>();
  const increment = api.counter.increment.useMutation({ error: 'Could not count' });
  increment.mutate({ counter: 'a' });
  api.counter.reset.useMutation().mutate({ counter: 'a' });
  expectTypeOf(api.counter.create.useMutation()).toEqualTypeOf<
    UseMutationResult<CounterRow, ClientError, { name: string }>
  >();
  api.chat.send.useMutation().mutate({ text: 'hi' });
  api.counter.changed.useEvent((event) => {
    expectTypeOf(event.payload.by).toEqualTypeOf<string>();
    expectTypeOf(event.name).toEqualTypeOf<'counter.changed'>();
  });
  api.chat.message.useEvent((event) => {
    expectTypeOf(event.payload.text).toEqualTypeOf<string>();
  });
  // @ts-expect-error -- increment is a mutation in the contract
  api.counter.increment.useQuery({ counter: 'a' }); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the intended error
  // @ts-expect-error -- reset is declared as a mutation
  api.counter.reset.useQuery({ counter: 'a' }); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the intended error
  // @ts-expect-error -- list is a query in the contract
  api.counter.list.useMutation(); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the intended error
  expectTypeOf(api.counter).not.toHaveProperty('hidden');
  expectTypeOf(api.counter).not.toHaveProperty('internal');
  // @ts-expect-error -- get needs its input
  api.counter.get.useQuery();
  // @ts-expect-error -- list takes no input
  api.counter.list.useQuery({ counter: 'a' });
  return null;
}

describe('createPluginClient', () => {
  it('calls RPCs outside components with typed results', () => {
    expectTypeOf(api.counter.list.call()).resolves.toEqualTypeOf<CounterRow[]>();
    expectTypeOf(
      api.counter.get.call({ counter: 'a' }),
    ).resolves.toEqualTypeOf<CounterRow | null>();
    // @ts-expect-error -- wrong input
    void api.chat.send.call({ text: 1 });
  });

  it('rejects definitions that name the wrong things', () => {
    createPluginClient(counter, {
      queries: {
        // @ts-expect-error -- not a panel RPC
        'counter.hidden': {},
      },
    });
    createPluginClient(counter, {
      queries: {
        // @ts-expect-error -- a mutation can't get query options
        'counter.increment': { refreshOn: ['counter.changed'] },
      },
    });
    createPluginClient(counter, {
      mutations: {
        // @ts-expect-error -- a query can't get mutation options
        'counter.list': { invalidates: [] },
      },
    });
    createPluginClient(counter, {
      // @ts-expect-error -- unknown event
      queries: { 'counter.list': { refreshOn: ['counter.nope'] } },
    });
    createPluginClient(counter, {
      // @ts-expect-error -- invalidates only names queries
      mutations: { 'counter.create': { invalidates: ['counter.increment'] } },
    });
    createPluginClient(counter, {
      queries: {
        // @ts-expect-error -- update must return the RPC's output
        'counter.list': { update: { 'counter.listChanged': () => 1 } },
      },
    });
  });

  it('takes read or write from the contract without a definition', () => {
    const bare = createPluginClient(counter);
    expectTypeOf(bare.counter.list).toHaveProperty('useQuery');
    expectTypeOf(bare.counter.get).toHaveProperty('useQuery');
    expectTypeOf(bare.counter.increment).toHaveProperty('useMutation');
    expectTypeOf(bare.counter.reset).toHaveProperty('useMutation');
    expectTypeOf(bare).not.toHaveProperty('chat');
  });

  it('rejects configuration for kinds a contract does not have', () => {
    // An empty mapped type would be `{}`, which accepts any key; these must still fail.
    const writes = defineContract({
      id: 'writes',
      version: '1.0.0',
      rpc: { add: { output: z.number(), expose: { panel: 'mod' } } },
    });
    const reads = defineContract({
      id: 'reads',
      version: '1.0.0',
      rpc: { list: { kind: 'query', output: z.number(), expose: { panel: 'mod' } } },
    });
    const empty = defineContract({ id: 'empty', version: '1.0.0' });
    createPluginClient(writes, { queries: {}, mutations: { 'writes.add': { invalidates: [] } } });
    createPluginClient(writes, {
      queries: {
        // @ts-expect-error -- writes has no queries
        'writes.add': {},
      },
    });
    createPluginClient(reads, { queries: { 'reads.list': {} }, mutations: {} });
    createPluginClient(reads, {
      mutations: {
        // @ts-expect-error -- reads has no mutations
        'reads.list': {},
      },
    });
    createPluginClient(empty, { queries: {}, mutations: {} });
    createPluginClient(empty, {
      // @ts-expect-error -- nothing to configure
      queries: { 'empty.list': {} },
    });
  });
});

interface RollbackContext {
  previous: CounterRow[];
}

/** Context must be inferred from onMutate and survive both hook and per-call callbacks. */
export function UsesMutationContext() {
  const mutation = api.counter.create.useMutation({
    onMutate: (input) => {
      expectTypeOf(input).toEqualTypeOf<{ name: string }>();
      return { previous: [] as CounterRow[] };
    },
    onSuccess: (data, input, context) => {
      expectTypeOf(data).toEqualTypeOf<CounterRow>();
      expectTypeOf(input).toEqualTypeOf<{ name: string }>();
      expectTypeOf(context).toEqualTypeOf<RollbackContext>();
    },
    onError: (error, input, context) => {
      expectTypeOf(error).toEqualTypeOf<ClientError>();
      expectTypeOf(input).toEqualTypeOf<{ name: string }>();
      expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
    },
    onSettled: (data, error, input, context) => {
      expectTypeOf(data).toEqualTypeOf<CounterRow | undefined>();
      expectTypeOf(error).toEqualTypeOf<ClientError | null>();
      expectTypeOf(input).toEqualTypeOf<{ name: string }>();
      expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
    },
  });
  expectTypeOf(mutation).toEqualTypeOf<
    UseMutationResult<CounterRow, ClientError, { name: string }, RollbackContext>
  >();
  expectTypeOf(mutation.context).toEqualTypeOf<RollbackContext | undefined>();
  mutation.mutate(
    { name: 'Deaths' },
    {
      onSuccess: (_data, _input, context) => {
        expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
      },
      onError: (_error, _input, context) => {
        expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
      },
      onSettled: (_data, _error, _input, context) => {
        expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
      },
    },
  );
  // Explicit context types remain available when the caller wants to declare one.
  api.counter.create.useMutation<RollbackContext>({ onMutate: () => ({ previous: [] }) });
  return null;
}

/** Async onMutate results are unwrapped; inputless RPCs consistently use void. */
export function UsesInputlessMutationContext() {
  const mutation = api.counter.clear.useMutation({
    onMutate: (input) => {
      expectTypeOf(input).toBeVoid();
      return Promise.resolve({ previous: [] as CounterRow[] });
    },
    onSuccess: (data, input, context) => {
      expectTypeOf(data).toEqualTypeOf<number>();
      expectTypeOf(input).toBeVoid();
      expectTypeOf(context).toEqualTypeOf<RollbackContext>();
    },
    onError: (_error, input, context) => {
      expectTypeOf(input).toBeVoid();
      expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
    },
    onSettled: (_data, _error, input, context) => {
      expectTypeOf(input).toBeVoid();
      expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
    },
  });
  expectTypeOf(mutation).toEqualTypeOf<
    UseMutationResult<number, ClientError, void, RollbackContext>
  >();
  mutation.mutate();
  expectTypeOf(mutation.mutateAsync()).toEqualTypeOf<Promise<number>>();
  mutation.mutate(undefined, {
    onSuccess: (_data, input, context) => {
      expectTypeOf(input).toBeVoid();
      expectTypeOf(context).toEqualTypeOf<RollbackContext | undefined>();
    },
  });
  return null;
}

export function UsesPresenters() {
  api.counter.increment.useMutation({
    presentFailure: (failure) => {
      expectTypeOf(failure.error.code).toEqualTypeOf<'counter-not-found'>();
      expectTypeOf(failure.error.counterId).toEqualTypeOf<string>();
      return 'Counter missing';
    },
  });
  api.counter.clear.useMutation({
    // @ts-expect-error -- a scalar output has no failure presenter
    presentFailure: () => 'wrong',
  });
  api.counter.done.useMutation({
    // @ts-expect-error -- success-only Results have no failure presenter
    presentFailure: () => 'wrong',
  });
  api.counter.increment.useMutation({
    // @ts-expect-error -- a presenter for another operation is incompatible
    presentFailure: (failure: { ok: false; reason: 'custom'; error: { code: 'busy' } }) =>
      failure.error.code,
  });
  return null;
}
