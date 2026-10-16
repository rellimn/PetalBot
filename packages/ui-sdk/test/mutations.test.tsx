import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Result, defineContract, defineFailure } from '@petalbot/sdk';
import { ClientError } from '../src';
import { createPluginClient, type MutationOptions } from '../src';
import { Toaster } from '../src';
import type { FakeSocket } from './fake-socket.ts';
import { renderWithPetal } from './render.tsx';

const soldOut = defineFailure({
  code: 'sold-out',
  reason: 'custom',
  details: z.object({ itemId: z.string() }),
});
const Item = z.object({ id: z.string() });
const shop = defineContract({
  id: 'shop',
  version: '1.0.0',
  rpc: {
    items: { kind: 'query', output: z.array(Item), expose: { panel: 'mod' } },
    stock: { kind: 'query', output: z.number(), expose: { panel: 'mod' } },
    buy: {
      input: z.object({ id: z.string() }),
      output: Result(z.object({ left: z.number() }), [soldOut]),
      expose: { panel: 'mod' },
    },
    scalar: { output: z.number(), expose: { panel: 'mod' } },
    broadcast: {
      output: z.record(z.string(), Result(z.object({ left: z.number() }), [soldOut])),
      expose: { panel: 'mod' },
    },
    note: { input: z.object({ text: z.string() }), output: z.object({}), expose: { panel: 'mod' } },
  },
});
const other = defineContract({
  id: 'other',
  version: '1.0.0',
  rpc: { status: { kind: 'query', output: z.string(), expose: { panel: 'mod' } } },
});

const api = createPluginClient(shop, {
  dependencies: [other],
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
  it('invalidates the own contract queries after success, with or without a definition, not the dependencies', async () => {
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
        { ok: false, reason: 'custom', error: { code: 'sold-out', itemId: 'a' } },
        (message) => message.name === 'shop.buy',
      );
    });
    expect(await screen.findByText('Could not buy')).toBeTruthy();
    expect(screen.getByText('The action could not be completed.')).toBeTruthy();
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

type BuyResult = z.output<typeof shop.rpc.buy.output>;
interface RollbackContext {
  previousStock: number;
}

/** Displays mutation state without mounting queries that would trigger unrelated RPCs. */
function BuyMutation({
  options,
  onCallSuccess,
}: {
  readonly options: MutationOptions<{ id: string }, BuyResult, RollbackContext>;
  readonly onCallSuccess?: (
    data: BuyResult,
    input: { id: string },
    context: RollbackContext | undefined,
  ) => void;
}) {
  const buy = api.shop.buy.useMutation(options);
  return (
    <Toaster>
      <p data-testid="mutation-status">{buy.status}</p>
      <button
        type="button"
        onClick={() => {
          buy.mutate({ id: 'a' }, { ...(onCallSuccess ? { onSuccess: onCallSuccess } : {}) });
        }}
      >
        Buy
      </button>
    </Toaster>
  );
}

describe('mutation callbacks', () => {
  it.each([false, true])(
    'awaits callback context for success or returned failure (%s)',
    async (failure) => {
      const prepared = Promise.withResolvers<RollbackContext>();
      const succeeded = Promise.withResolvers<undefined>();
      const onCallSuccess = vi.fn();
      const settled = Promise.withResolvers<undefined>();
      const rollback = { previousStock: 3 };
      const result = failure
        ? { ok: false, reason: 'custom', error: { code: 'sold-out', itemId: 'a' } }
        : { ok: true, left: 2 };
      const onMutate = vi.fn(() => prepared.promise);
      const onSuccess = vi.fn(() => succeeded.promise);
      const onError = vi.fn();
      const onSettled = vi.fn(() => settled.promise);
      const { socket, queryClient } = renderWithPetal(
        <BuyMutation
          options={{ onMutate, onSuccess, onError, onSettled }}
          onCallSuccess={onCallSuccess}
        />,
      );
      const mutationContext: unknown = expect.objectContaining({ client: queryClient });

      await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
      expect(onMutate).toHaveBeenCalledExactlyOnceWith({ id: 'a' }, mutationContext);
      expect(calls(socket, 'shop.buy')).toBe(0);
      expect(screen.getByTestId('mutation-status').textContent).toBe('pending');

      await act(async () => {
        prepared.resolve(rollback);
        await prepared.promise;
      });
      await waitFor(() => {
        expect(calls(socket, 'shop.buy')).toBe(1);
      });
      act(() => {
        socket.answer('rpc', result, (message) => message.name === 'shop.buy');
      });
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledExactlyOnceWith(
          result,
          { id: 'a' },
          rollback,
          mutationContext,
        );
      });
      expect(onSettled).not.toHaveBeenCalled();
      expect(onCallSuccess).not.toHaveBeenCalled();
      expect(screen.getByTestId('mutation-status').textContent).toBe('pending');

      await act(async () => {
        succeeded.resolve(undefined);
        await succeeded.promise;
      });
      await waitFor(() => {
        expect(onSettled).toHaveBeenCalledExactlyOnceWith(
          result,
          null,
          { id: 'a' },
          rollback,
          mutationContext,
        );
      });
      expect(screen.getByTestId('mutation-status').textContent).toBe('pending');

      await act(async () => {
        settled.resolve(undefined);
        await settled.promise;
      });
      await waitFor(() => {
        expect(screen.getByTestId('mutation-status').textContent).toBe('success');
      });
      expect(onCallSuccess).toHaveBeenCalledExactlyOnceWith(
        result,
        { id: 'a' },
        rollback,
        mutationContext,
      );
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('passes rollback context to onError and waits for it before onSettled', async () => {
    const handled = Promise.withResolvers<undefined>();
    const rollback = { previousStock: 3 };
    const onSuccess = vi.fn();
    const onError = vi.fn(() => handled.promise);
    const onSettled = vi.fn();
    const { socket, queryClient } = renderWithPetal(
      <BuyMutation
        options={{
          onMutate: () => rollback,
          onSuccess,
          onError,
          onSettled,
          error: 'Could not buy',
        }}
      />,
    );
    const error = new ClientError('forbidden', 'Not allowed');
    const mutationContext: unknown = expect.objectContaining({ client: queryClient });

    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    await waitFor(() => {
      expect(calls(socket, 'shop.buy')).toBe(1);
    });
    act(() => {
      socket.fail('rpc', error.code, error.message, (message) => message.name === 'shop.buy');
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        error,
        { id: 'a' },
        rollback,
        mutationContext,
      );
    });
    expect(await screen.findByText('Could not buy')).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByTestId('mutation-status').textContent).toBe('pending');

    await act(async () => {
      handled.resolve(undefined);
      await handled.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId('mutation-status').textContent).toBe('error');
    });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(
      undefined,
      error,
      { id: 'a' },
      rollback,
      mutationContext,
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('passes undefined rollback context when onMutate fails before sending the RPC', async () => {
    const error = new ClientError('unavailable', 'Cannot prepare the update');
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { socket, queryClient } = renderWithPetal(
      <BuyMutation
        options={{
          onMutate: () => Promise.reject(error),
          onSuccess,
          onError,
          onSettled,
        }}
      />,
    );
    const mutationContext: unknown = expect.objectContaining({ client: queryClient });

    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    await waitFor(() => {
      expect(screen.getByTestId('mutation-status').textContent).toBe('error');
    });
    expect(calls(socket, 'shop.buy')).toBe(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, { id: 'a' }, undefined, mutationContext);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(
      undefined,
      error,
      { id: 'a' },
      undefined,
      mutationContext,
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the resolved lifecycle for a failed Result without a success toast (error toast: %s)',
    async (showErrorToast) => {
      const rollback = { previousStock: 3 };
      const result = { ok: false, reason: 'custom', error: { code: 'sold-out', itemId: 'a' } };
      const success = vi.fn(() => ({ title: 'Purchase succeeded' }));
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      const { socket, queryClient } = renderWithPetal(
        <BuyMutation
          options={{
            onMutate: () => rollback,
            onSuccess,
            onError,
            onSettled,
            success,
            ...(showErrorToast ? { error: 'Could not buy' } : {}),
          }}
        />,
      );
      const mutationContext: unknown = expect.objectContaining({ client: queryClient });

      await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
      await waitFor(() => {
        expect(calls(socket, 'shop.buy')).toBe(1);
      });
      act(() => {
        socket.answer('rpc', result, (message) => message.name === 'shop.buy');
      });
      await waitFor(() => {
        expect(screen.getByTestId('mutation-status').textContent).toBe('success');
      });
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(
        result,
        { id: 'a' },
        rollback,
        mutationContext,
      );
      expect(onSettled).toHaveBeenCalledExactlyOnceWith(
        result,
        null,
        { id: 'a' },
        rollback,
        mutationContext,
      );
      expect(onError).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(screen.queryByText('Purchase succeeded')).toBeNull();
      if (showErrorToast) {
        expect(await screen.findByText('Could not buy')).toBeTruthy();
      } else {
        expect(screen.queryByText('Could not buy')).toBeNull();
      }
    },
  );
});

describe('failure presentation', () => {
  it.each(['default', 'explicit', 'fallback', 'silent', 'rejected'] as const)(
    'uses %s presentation without exposing diagnostics',
    async (mode) => {
      const presenter = vi.fn((failure: Extract<BuyResult, { ok: false }>) =>
        mode === 'fallback' ? undefined : `Item ${failure.error.itemId} is sold out.`,
      );
      const error = vi.fn((problem: { message: string }) => ({
        title: 'Could not buy',
        description: problem.message,
      }));
      const { socket } = renderWithPetal(
        <BuyMutation
          options={{
            ...(mode === 'silent' ? {} : { error }),
            ...(mode === 'default' ? {} : { presentFailure: presenter }),
            success: 'never',
          }}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
      act(() => {
        if (mode === 'rejected') socket.fail('rpc', 'forbidden', 'Not allowed');
        else
          socket.answer('rpc', {
            ok: false,
            reason: 'custom',
            error: { code: 'sold-out', itemId: 'a' },
            message: 'DIAGNOSTIC_ONLY',
          });
      });
      await waitFor(() => {
        expect(screen.getByTestId('mutation-status').textContent).toBe(
          mode === 'rejected' ? 'error' : 'success',
        );
      });
      if (mode === 'silent') {
        expect(error).not.toHaveBeenCalled();
        expect(presenter).not.toHaveBeenCalled();
      } else {
        const message =
          mode === 'rejected'
            ? 'Not allowed'
            : mode === 'explicit'
              ? 'Item a is sold out.'
              : 'The action could not be completed.';
        expect(await screen.findByText(message)).toBeTruthy();
        if (mode !== 'rejected') expect(error).toHaveBeenCalledExactlyOnceWith({ message });
        else expect(presenter).not.toHaveBeenCalled();
      }
      expect(screen.queryByText('DIAGNOSTIC_ONLY')).toBeNull();
      expect(screen.queryByText('never')).toBeNull();
    },
  );
});

function OrdinaryMutation() {
  const scalar = api.shop.scalar.useMutation({
    success: 'Scalar succeeded',
    error: 'Scalar failed',
  });
  const broadcast = api.shop.broadcast.useMutation({
    success: 'Broadcast returned',
    error: 'Broadcast failed',
  });
  return (
    <Toaster>
      <button
        type="button"
        onClick={() => {
          scalar.mutate();
        }}
      >
        Scalar
      </button>
      <button
        type="button"
        onClick={() => {
          broadcast.mutate();
        }}
      >
        Broadcast
      </button>
    </Toaster>
  );
}

it('does not interpret scalar or nested Result outputs as top-level failures', async () => {
  const { socket } = renderWithPetal(<OrdinaryMutation />);
  await userEvent.click(screen.getByRole('button', { name: 'Scalar' }));
  act(() => {
    socket.answer('rpc', 3, (message) => message.name === 'shop.scalar');
  });
  expect(await screen.findByText('Scalar succeeded')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Broadcast' }));
  act(() => {
    socket.answer(
      'rpc',
      { one: { ok: false, reason: 'custom', error: { code: 'sold-out', itemId: 'a' } } },
      (message) => message.name === 'shop.broadcast',
    );
  });
  expect(await screen.findByText('Broadcast returned')).toBeTruthy();
  expect(screen.queryByText('Broadcast failed')).toBeNull();
});

const presenting = createPluginClient(shop, {
  failures: { 'sold-out': (failure) => `Item ${failure.error.itemId} is gone.` },
});

function PresentedBuy({ override }: { readonly override: (() => string | undefined) | undefined }) {
  const buy = presenting.shop.buy.useMutation({
    error: 'Could not buy',
    ...(override === undefined ? {} : { presentFailure: override }),
  });
  return (
    <Toaster>
      <button
        type="button"
        onClick={() => {
          buy.mutate({ id: 'a' });
        }}
      >
        Buy
      </button>
    </Toaster>
  );
}

describe('client failure presenters', () => {
  const cases: [string, (() => string | undefined) | undefined, string][] = [
    ['the client presenter', undefined, 'Item a is gone.'],
    ['a mutation override', () => 'Overridden.', 'Overridden.'],
    ['the client presenter after an undefined override', () => undefined, 'Item a is gone.'],
  ];
  it.each(cases)('uses %s', async (_name, override, text) => {
    const { socket } = renderWithPetal(<PresentedBuy override={override} />);
    await userEvent.click(screen.getByRole('button', { name: 'Buy' }));
    act(() => {
      socket.answer('rpc', {
        ok: false,
        reason: 'custom',
        error: { code: 'sold-out', itemId: 'a' },
      });
    });
    expect(await screen.findByText(text)).toBeTruthy();
  });
});
