import type { UseMutationResult } from '@tanstack/react-query';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Choices, Result, defineContract } from '@petalbot/sdk';
import type { ClientError } from '../src/client/errors.ts';
import { createPluginClient } from '../src/client/plugin-client.ts';

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
    list: { output: z.array(Counter), expose: { panel: 'mod' } },
    options: { output: Choices, expose: { panel: 'mod' } },
    get: { input: Ref, output: Counter.nullable(), expose: { panel: 'mod', overlay: true } },
    increment: {
      input: Ref,
      output: Result(z.object({ counter: Counter })),
      expose: { panel: 'mod' },
    },
    create: { input: z.object({ name: z.string() }), output: Counter, expose: { panel: 'owner' } },
    hidden: { output: z.string() },
  },
});
const chat = defineContract({
  id: 'chat',
  version: '1.0.0',
  events: { message: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: {
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
    'counter.options': {},
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
  },
  mutations: { 'counter.create': { invalidates: ['counter.list'] } },
});

/** Hooks must be called in a component; type tests only need it to compile. */
export function Uses() {
  const list = api.counter.list.useQuery();
  expectTypeOf(list.data).toEqualTypeOf<CounterRow[] | undefined>();
  expectTypeOf(list.error).toEqualTypeOf<ClientError | null>();
  api.counter.list.useQuery({ enabled: false });
  const one = api.counter.get.useQuery({ counter: 'a' }, { refetchInterval: 1000 });
  expectTypeOf(one.data).toEqualTypeOf<CounterRow | null | undefined>();
  const increment = api.counter.increment.useMutation({ error: 'Could not count' });
  increment.mutate({ counter: 'a' });
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
  // @ts-expect-error -- increment is not a query
  api.counter.increment.useQuery({ counter: 'a' }); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the intended error
  // @ts-expect-error -- list is a query, not a mutation
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
      // @ts-expect-error -- unknown event
      queries: { 'counter.list': { refreshOn: ['counter.nope'] } },
    });
    createPluginClient(counter, {
      queries: { 'counter.list': {} },
      // @ts-expect-error -- invalidates only names queries
      mutations: { 'counter.create': { invalidates: ['counter.get'] } },
    });
    createPluginClient(counter, {
      queries: {
        // @ts-expect-error -- update must return the RPC's output
        'counter.list': { update: { 'counter.listChanged': () => 1 } },
      },
    });
  });

  it('treats every RPC as a mutation without a definition', () => {
    const bare = createPluginClient(counter);
    expectTypeOf(bare.counter.list).toHaveProperty('useMutation');
    expectTypeOf(bare).not.toHaveProperty('chat');
  });
});
