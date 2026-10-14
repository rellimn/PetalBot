import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { codecs, defineContract } from '@petalbot/sdk';
import { useConnectionStatus, usePlugins, useUser } from '../src/client/context.tsx';
import { createPluginClient, useDeclaredQuery } from '../src/client/plugin-client.ts';
import { renderWithPetal } from './render.tsx';

const quotesContract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: { added: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: {
    list: { kind: 'query', output: z.array(z.string()), expose: { panel: 'mod' } },
    find: {
      kind: 'query',
      input: z.object({ text: z.string() }),
      output: z.string(),
      expose: { panel: 'mod' },
    },
    add: {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string() }),
      expose: { panel: 'mod' },
    },
    secret: { output: z.string() },
  },
});
// No definition: the contract alone decides that list and find are queries.
const api = createPluginClient(quotesContract);

const event = (text: string) => ({
  type: 'event',
  envelope: {
    id: text,
    name: 'quotes.added',
    payload: { text },
    source: 'quotes',
    timestamp: 1,
    depth: 0,
  },
});

function QuotesPage() {
  const list = api.quotes.list.useQuery();
  const add = api.quotes.add.useMutation();
  const [last, setLast] = useState('none');
  api.quotes.added.useEvent((received) => {
    setLast(received.payload.text);
  });
  return (
    <div>
      <p>quotes: {list.data?.join(', ') ?? 'loading'}</p>
      <p>last: {last}</p>
      <button
        type="button"
        onClick={() => {
          add.mutate({ text: 'new' });
        }}
      >
        Add
      </button>
      <p>added: {add.data?.id ?? '-'}</p>
    </div>
  );
}

describe('createPluginClient', () => {
  it('builds one namespace per contract with only panel-exposed members', () => {
    expect(Object.keys(api)).toEqual(['quotes']);
    expect(Object.keys(api.quotes).toSorted()).toEqual(['add', 'added', 'find', 'list']);
    expect(Object.keys(api.quotes.list).toSorted()).toEqual(['call', 'useQuery']);
    expect(Object.keys(api.quotes.add).toSorted()).toEqual(['call', 'useMutation']);
    expect(Object.keys(api.quotes.added)).toEqual(['useEvent']);
  });

  it('queries without input, mutates and listens through the shared connection', async () => {
    const { socket, unmount } = renderWithPetal(<QuotesPage />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'quotes.list' }]);
    });
    expect(socket.ofType('rpc')[0]).not.toHaveProperty('input');
    act(() => {
      socket.answer('rpc', ['a', 'b'], (message) => message.name === 'quotes.list');
    });
    expect(await screen.findByText('quotes: a, b')).toBeTruthy();

    expect(socket.ofType('subscribe')).toMatchObject([{ event: 'quotes.added' }]);
    act(() => {
      socket.receive(event('hello'));
    });
    expect(screen.getByText('last: hello')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(socket.ofType('rpc').at(-1)).toMatchObject({
        name: 'quotes.add',
        input: { text: 'new' },
      });
    });
    act(() => {
      socket.answer('rpc', { id: 'q1' }, (message) => message.name === 'quotes.add');
    });
    expect(await screen.findByText('added: q1')).toBeTruthy();

    unmount();
    expect(socket.ofType('unsubscribe')).toMatchObject([{ event: 'quotes.added' }]);
  });

  it('passes input and per-use options to useQuery', async () => {
    function Find() {
      const [enabled, setEnabled] = useState(false);
      const found = api.quotes.find.useQuery({ text: 'x' }, { enabled });
      return (
        <button
          type="button"
          onClick={() => {
            setEnabled(true);
          }}
        >
          found: {found.data ?? '-'}
        </button>
      );
    }
    const { socket } = renderWithPetal(<Find />);
    await screen.findByText('found: -');
    expect(socket.ofType('rpc')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'found: -' }));
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'quotes.find', input: { text: 'x' } }]);
    });
  });

  it('calls outside components through the registered connection', async () => {
    const { socket } = renderWithPetal(<p>idle</p>);
    const pending = api.quotes.add.call({ text: 'x' });
    socket.answer('rpc', { id: 'q2' });
    await expect(pending).resolves.toEqual({ id: 'q2' });
    const listed = api.quotes.list.call();
    expect(socket.ofType('rpc').at(-1)).toMatchObject({ name: 'quotes.list' });
    socket.answer('rpc', []);
    await expect(listed).resolves.toEqual([]);
  });

  it('exposes the user, the connection status and the plugin list', () => {
    function Status() {
      const user = useUser();
      const status = useConnectionStatus();
      const plugins = usePlugins();
      return (
        <p>
          {user.name} {status} {plugins.size}
        </p>
      );
    }
    const { socket } = renderWithPetal(<Status />);
    expect(screen.getByText('roman open 0')).toBeTruthy();
    act(() => {
      socket.drop();
    });
    expect(screen.getByText('roman reconnecting 0')).toBeTruthy();
  });
});

const fansContract = defineContract({
  id: 'fans',
  version: '1.0.0',
  rpc: { count: { kind: 'query', output: z.number(), expose: { panel: 'mod' } } },
});

function Declared({ name }: { readonly name: string }) {
  const result = useDeclaredQuery(name, undefined);
  return <p>declared: {result.isSuccess ? 'yes' : 'no'}</p>;
}

describe('useDeclaredQuery registration', () => {
  it("never replaces the owner's live definition with a dependent's plain use", async () => {
    // The owner's client declares how quotes.list stays live ...
    createPluginClient(quotesContract, {
      queries: { 'quotes.list': { refreshOn: ['quotes.added'] } },
    });
    // ... and a dependent plugin's client uses it without a definition.
    createPluginClient(fansContract, { dependencies: [quotesContract] });
    const { socket } = renderWithPetal(<Declared name="quotes.list" />);
    // Live: it subscribes to the owner's event before querying.
    await waitFor(() => {
      expect(socket.ofType('subscribe')).toMatchObject([{ event: 'quotes.added' }]);
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'quotes.list' }]);
    });
  });

  it('lets a reloaded owner client drop its live options', async () => {
    const notes = defineContract({
      id: 'notes',
      version: '1.0.0',
      events: { added: { schema: z.object({}), expose: ['panel'] } },
      rpc: { list: { kind: 'query', output: z.array(z.string()), expose: { panel: 'mod' } } },
    });
    createPluginClient(notes, { queries: { 'notes.list': { refreshOn: ['notes.added'] } } });
    // The reloaded bundle creates its client again, now without live options.
    createPluginClient(notes);
    const { socket } = renderWithPetal(<Declared name="notes.list" />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'notes.list' }]);
    });
    // Subscribe frames would have gone out before the rpc frame.
    expect(socket.ofType('subscribe')).toEqual([]);
  });

  it('decodes with the schemas of a reloaded owner client', async () => {
    const v1 = defineContract({
      id: 'dates',
      version: '1.0.0',
      rpc: {
        next: { kind: 'query', output: z.object({ at: z.string() }), expose: { panel: 'mod' } },
      },
    });
    const v2 = defineContract({
      id: 'dates',
      version: '2.0.0',
      rpc: {
        next: {
          kind: 'query',
          output: z.object({ at: codecs.isoDate() }),
          expose: { panel: 'mod' },
        },
      },
    });
    createPluginClient(v1);
    createPluginClient(v2);
    function Next() {
      const next = useDeclaredQuery('dates.next', undefined);
      const at = (next.data as { at?: unknown } | undefined)?.at;
      return <p>at: {at instanceof Date ? 'date' : typeof at}</p>;
    }
    const { socket } = renderWithPetal(<Next />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'dates.next' }]);
    });
    act(() => {
      socket.answer('rpc', { at: '2026-10-14T00:00:00.000Z' });
    });
    expect(await screen.findByText('at: date')).toBeTruthy();
  });
});
