import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { useConnectionStatus, usePlugins, useUser } from '../src/client/context.tsx';
import { renderWithPetal } from './render.tsx';

const quotesContract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: { added: { schema: z.object({ text: z.string() }), expose: ['panel'] } },
  rpc: {
    list: { input: z.object({}), output: z.array(z.string()), expose: { panel: 'mod' } },
    add: {
      input: z.object({ text: z.string() }),
      output: z.object({ id: z.string() }),
      expose: { panel: 'mod' },
    },
  },
});
const quotes = createPluginClient(quotesContract);

function QuotesPage() {
  const list = quotes.useRpc('quotes.list', {});
  const add = quotes.useMutation('quotes.add');
  const [last, setLast] = useState('none');
  quotes.useEvent('quotes.added', (event) => {
    setLast(event.payload.text);
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
  it('queries, mutates and listens through the shared connection', async () => {
    const { socket, unmount } = renderWithPetal(<QuotesPage />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'quotes.list', input: {} }]);
    });
    act(() => {
      socket.answer('rpc', ['a', 'b'], (message) => message.name === 'quotes.list');
    });
    expect(await screen.findByText('quotes: a, b')).toBeTruthy();

    expect(socket.ofType('subscribe')).toMatchObject([{ event: 'quotes.added' }]);
    act(() => {
      socket.receive({
        type: 'event',
        envelope: {
          id: '1',
          name: 'quotes.added',
          payload: { text: 'hello' },
          source: 'quotes',
          timestamp: 1,
          depth: 0,
        },
      });
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

  it('remembers its dependency ids', () => {
    const chatContract = defineContract({ id: 'chat', version: '1.0.0' });
    expect(createPluginClient(quotesContract, [chatContract]).dependencies).toEqual(['chat']);
    expect(quotes.dependencies).toEqual([]);
  });

  it('calls outside components through the registered connection', async () => {
    const { socket } = renderWithPetal(<p>idle</p>);
    const pending = quotes.call('quotes.add', { text: 'x' });
    socket.answer('rpc', { id: 'q2' });
    await expect(pending).resolves.toEqual({ id: 'q2' });
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
