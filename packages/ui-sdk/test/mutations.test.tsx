import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Result, defineContract } from '@petalbot/sdk';
import { createPluginClient } from '../src/client/plugin-client.ts';
import { Toaster } from '../src/components/Toaster.tsx';
import type { FakeSocket } from './fake-socket.ts';
import { renderWithPetal } from './render.tsx';

const Item = z.object({ id: z.string() });
const shop = defineContract({
  id: 'shop',
  version: '1.0.0',
  rpc: {
    items: { output: z.array(Item), expose: { panel: 'mod' } },
    stock: { output: z.number(), expose: { panel: 'mod' } },
    buy: {
      input: z.object({ id: z.string() }),
      output: Result(z.object({ left: z.number() })),
      expose: { panel: 'mod' },
    },
    note: { input: z.object({ text: z.string() }), output: z.object({}), expose: { panel: 'mod' } },
  },
});
const other = defineContract({
  id: 'other',
  version: '1.0.0',
  rpc: { status: { output: z.string(), expose: { panel: 'mod' } } },
});

const api = createPluginClient(shop, {
  dependencies: [other],
  queries: { 'shop.items': {}, 'shop.stock': {}, 'other.status': {} },
  mutations: { 'shop.note': { invalidates: ['shop.stock'] } },
});

const calls = (socket: FakeSocket, name: string) =>
  socket.ofType('rpc').filter((message) => message.name === name).length;

function Shop() {
  const items = api.shop.items.useQuery();
  const stock = api.shop.stock.useQuery();
  const status = api.other.status.useQuery();
  const buy = api.shop.buy.useMutation({
    success: (data) => ({ title: data.ok ? `Bought, ${String(data.left)} left` : 'never' }),
    error: 'Could not buy',
  });
  const note = api.shop.note.useMutation();
  return (
    <Toaster>
      <div>
        <p>
          {items.data?.length ?? '...'} / {stock.data ?? '...'} / {status.data ?? '...'}
        </p>
        <button
          type="button"
          onClick={() => {
            buy.mutate({ id: 'a' });
          }}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => {
            note.mutate({ text: 'x' });
          }}
        >
          Note
        </button>
      </div>
    </Toaster>
  );
}

async function loaded() {
  const harness = renderWithPetal(<Shop />);
  const { socket } = harness;
  await waitFor(() => {
    expect(socket.ofType('rpc')).toHaveLength(3);
  });
  act(() => {
    socket.answer('rpc', [], (message) => message.name === 'shop.items');
    socket.answer('rpc', 3, (message) => message.name === 'shop.stock');
    socket.answer('rpc', 'fine', (message) => message.name === 'other.status');
  });
  await screen.findByText('0 / 3 / fine');
  return harness;
}

describe('mutations', () => {
  it('invalidates the own contract queries after success, not the dependencies', async () => {
    const { socket } = await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    act(() => {
      socket.answer('rpc', { ok: true, left: 2 }, (message) => message.name === 'shop.buy');
    });
    await waitFor(() => {
      expect(calls(socket, 'shop.items')).toBe(2);
      expect(calls(socket, 'shop.stock')).toBe(2);
    });
    expect(calls(socket, 'other.status')).toBe(1);
    expect(await screen.findByText('Bought, 2 left')).toBeTruthy();
  });

  it('invalidates only the listed queries when invalidates is set', async () => {
    const { socket } = await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Note' }));
    act(() => {
      socket.answer('rpc', {}, (message) => message.name === 'shop.note');
    });
    await waitFor(() => {
      expect(calls(socket, 'shop.stock')).toBe(2);
    });
    expect(calls(socket, 'shop.items')).toBe(1);
  });

  it('treats a failed Result as an error for toasts', async () => {
    const { socket } = await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    act(() => {
      socket.answer(
        'rpc',
        { ok: false, reason: 'not-found', message: 'Sold out' },
        (message) => message.name === 'shop.buy',
      );
    });
    expect(await screen.findByText('Could not buy')).toBeTruthy();
    expect(screen.getByText('Sold out')).toBeTruthy();
    expect(screen.queryByText(/Bought/)).toBeNull();
    await waitFor(() => {
      expect(calls(socket, 'shop.items')).toBe(2);
    });
  });

  it('shows the error toast with the message when the call fails', async () => {
    const { socket } = await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    const sent = socket.ofType('rpc').at(-1);
    act(() => {
      socket.receive({
        type: 'reply',
        id: sent?.id,
        error: { code: 'forbidden', message: 'Not allowed' },
      });
    });
    expect(await screen.findByText('Could not buy')).toBeTruthy();
    expect(screen.getByText('Not allowed')).toBeTruthy();
    expect(calls(socket, 'shop.items')).toBe(1);
  });
});
