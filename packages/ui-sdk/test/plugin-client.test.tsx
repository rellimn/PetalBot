import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { useConnectionStatus, usePlugins, useUser } from '../src/client/context.tsx';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { renderWithPetal } from './render.tsx';

const quotesContract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: { added: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: {
    list: { output: z.array(z.string()), expose: { panel: 'mod' } },
    find: { input: z.object({ text: z.string() }), output: z.string(), expose: { panel: 'mod' } },
    add: {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string() }),
      expose: { panel: 'mod' },
    },
    secret: { output: z.string() },
  },
});
const api = createPluginClient(quotesContract, {
  queries: { 'quotes.list': {}, 'quotes.find': {} },
});

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
