import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { FakeSocket, ownerUser } from './fake-socket.ts';
import { renderWithPetal } from './render.tsx';

const quotesContract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: {
    added: { schema: z.object({ text: z.string() }), expose: ['panel'] },
    cleared: { schema: z.object({}), expose: ['panel'] },
  },
  rpc: {
    list: { input: z.object({}), output: z.array(z.string()), expose: { panel: 'mod' } },
  },
});
const refreshing = createPluginClient(quotesContract, {
  queries: { 'quotes.list': { refreshOn: ['quotes.added'] } },
});
const patching = createPluginClient(quotesContract, {
  queries: {
    'quotes.list': {
      refreshOn: ['quotes.cleared'],
      update: { 'quotes.added': (texts, event) => [...texts, event.payload.text] },
    },
  },
});
const broken = createPluginClient(quotesContract, {
  queries: {
    'quotes.list': {
      update: {
        'quotes.added': () => {
          throw new Error('boom');
        },
      },
    },
  },
});

const added = (id: string, text: string) => ({
  type: 'event',
  envelope: {
    id,
    name: 'quotes.added',
    payload: { text },
    source: 'quotes',
    timestamp: 1,
    depth: 0,
  },
});
const listCalls = (socket: FakeSocket) =>
  socket.ofType('rpc').filter((message) => message.name === 'quotes.list');
const sentTypes = (socket: FakeSocket) => socket.sent.map((message) => message.type);

function Refreshing() {
  const list = refreshing.quotes.list.useQuery({});
  return <p>refreshing: {list.data?.join(', ') ?? 'loading'}</p>;
}

function Patching({ label }: { readonly label: string }) {
  const list = patching.quotes.list.useQuery({});
  return (
    <p>
      {label}: {list.data?.join(', ') ?? 'loading'}
    </p>
  );
}

const byKey = defineContract({
  id: 'keyed',
  version: '1.0.0',
  events: {
    changed: { schema: z.object({ key: z.string(), value: z.number() }), expose: ['panel'] },
  },
  rpc: {
    get: {
      input: z.object({ key: z.string() }),
      output: z.object({ key: z.string(), value: z.number() }),
      expose: { panel: 'mod' },
    },
  },
});
const keyedClient = createPluginClient(byKey, {
  queries: {
    'keyed.get': {
      update: {
        'keyed.changed': (data, event, input) =>
          event.payload.key === input.key ? { ...data, value: event.payload.value } : data,
      },
    },
  },
});
const renders: string[] = [];
function Keyed({ name }: { readonly name: string }) {
  const value = keyedClient.keyed.get.useQuery({ key: name });
  renders.push(name);
  return (
    <p>
      {name}: {value.data?.value ?? '…'}
    </p>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live RPC queries', () => {
  it('refetches on refreshOn events and subscribes before it fetches', async () => {
    const { socket } = renderWithPetal(<Refreshing />);
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    expect(sentTypes(socket).indexOf('subscribe')).toBeLessThan(sentTypes(socket).indexOf('rpc'));
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('refreshing: a')).toBeTruthy();
    act(() => {
      socket.receive(added('1', 'b'));
    });
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(2);
    });
    act(() => {
      socket.answer('rpc', ['a', 'b']);
    });
    expect(await screen.findByText('refreshing: a, b')).toBeTruthy();
  });

  it('patches the cache once per event, however many components show the query', async () => {
    const { socket } = renderWithPetal(
      <>
        <Patching label="first" />
        <Patching label="second" />
      </>,
    );
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('first: a')).toBeTruthy();
    expect(socket.ofType('subscribe').map((message) => message.event)).toEqual([
      'quotes.added',
      'quotes.cleared',
    ]);
    act(() => {
      socket.receive(added('1', 'b'));
    });
    expect(await screen.findByText('first: a, b')).toBeTruthy();
    expect(screen.getByText('second: a, b')).toBeTruthy();
    expect(listCalls(socket)).toHaveLength(1);
  });

  it('binds once under StrictMode', async () => {
    const { socket } = renderWithPetal(
      <StrictMode>
        <Patching label="strict" />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(listCalls(socket).length).toBeGreaterThan(0);
    });
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('strict: a')).toBeTruthy();
    act(() => {
      socket.receive(added('1', 'b'));
    });
    expect(await screen.findByText('strict: a, b')).toBeTruthy();
  });

  it('refetches instead of patching while a fetch is in flight', async () => {
    const { socket } = renderWithPetal(<Patching label="list" />);
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      socket.receive(added('1', 'b'));
    });
    // The first answer predates the event: the query fetches once more after it.
    act(() => {
      socket.answer('rpc', ['a']);
    });
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(2);
    });
    act(() => {
      socket.answer('rpc', ['a', 'b']);
    });
    expect(await screen.findByText('list: a, b')).toBeTruthy();
  });

  it('lets a fetch finish during a burst of events and refetches once afterwards', async () => {
    const { socket } = renderWithPetal(<Refreshing />);
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      for (let index = 1; index <= 5; index += 1) socket.receive(added(String(index), 'x'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listCalls(socket)).toHaveLength(1);
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('refreshing: a')).toBeTruthy();
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(2);
    });
    act(() => {
      socket.answer('rpc', ['a', 'x']);
    });
    expect(await screen.findByText('refreshing: a, x')).toBeTruthy();
    expect(listCalls(socket)).toHaveLength(2);
  });

  it('falls back to a refetch when an update throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken() {
      const list = broken.quotes.list.useQuery({});
      return <p>broken: {list.data?.join(', ') ?? 'loading'}</p>;
    }
    const { socket } = renderWithPetal(<Broken />);
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('broken: a')).toBeTruthy();
    act(() => {
      socket.receive(added('1', 'b'));
    });
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(2);
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it('refetches after a reconnect, once the subscriptions are back', async () => {
    const { socket } = renderWithPetal(<Refreshing />, ownerUser, {
      backoff: { initialMs: 1, maxMs: 1 },
    });
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('refreshing: a')).toBeTruthy();
    act(() => {
      socket.drop();
    });
    await waitFor(() => {
      expect(FakeSocket.all).toHaveLength(2);
    });
    const next = FakeSocket.latest();
    act(() => {
      next.hello();
    });
    await waitFor(() => {
      expect(listCalls(next)).toHaveLength(1);
    });
    expect(sentTypes(next).indexOf('subscribe')).toBeLessThan(sentTypes(next).indexOf('rpc'));
  });

  it('unsubscribes when the last component using the query unmounts', async () => {
    const { socket, unmount } = renderWithPetal(<Refreshing />);
    await waitFor(() => {
      expect(socket.ofType('subscribe')).toHaveLength(1);
    });
    unmount();
    expect(socket.ofType('unsubscribe')).toMatchObject([{ event: 'quotes.added' }]);
  });

  it('refetches cached data when a live query is shown again, even while fresh', async () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown(!shown);
            }}
          >
            toggle
          </button>
          {shown ? <Refreshing /> : null}
        </>
      );
    }
    const { socket, queryClient } = renderWithPetal(<Toggle />);
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(1);
    });
    act(() => {
      socket.answer('rpc', ['a']);
    });
    expect(await screen.findByText('refreshing: a')).toBeTruthy();
    queryClient.setQueryDefaults(['petalbot'], { staleTime: Infinity });
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByText('refreshing: a')).toBeTruthy();
    await waitFor(() => {
      expect(listCalls(socket)).toHaveLength(2);
    });
  });
  it('passes the query input to update and leaves other entries untouched', async () => {
    const { socket } = renderWithPetal(
      <>
        <Keyed name="a" />
        <Keyed name="b" />
      </>,
    );
    await waitFor(() => {
      expect(socket.ofType('rpc')).toHaveLength(2);
    });
    act(() => {
      socket.answer(
        'rpc',
        { key: 'a', value: 1 },
        (message) => (message.input as { key: string }).key === 'a',
      );
      socket.answer(
        'rpc',
        { key: 'b', value: 1 },
        (message) => (message.input as { key: string }).key === 'b',
      );
    });
    await screen.findByText('b: 1');
    renders.length = 0;
    act(() => {
      socket.receive({
        type: 'event',
        envelope: {
          id: 'e1',
          name: 'keyed.changed',
          payload: { key: 'a', value: 5 },
          source: 'keyed',
          timestamp: 1,
          depth: 0,
        },
      });
    });
    expect(await screen.findByText('a: 5')).toBeTruthy();
    expect(screen.getByText('b: 1')).toBeTruthy();
    expect(renders).not.toContain('b');
  });
});
