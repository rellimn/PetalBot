import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PanelUser } from '@petalbot/sdk';
import { PetalConnection, type ConnectionOptions } from '../src/client/connection.ts';
import { PetalProvider, registerConnection } from '../src/client/context.tsx';
import { createApi } from '../src/client/http.ts';
import { FakeSocket, ownerUser } from './fake-socket.ts';

/** Renders `ui` inside a PetalProvider whose connection is already open on a FakeSocket. */
export function renderWithPetal(
  ui: ReactNode,
  user: PanelUser = ownerUser,
  options: Partial<ConnectionOptions> = {},
) {
  FakeSocket.reset();
  const connection = new PetalConnection({
    url: 'ws://panel.test/ws',
    createSocket: (url) => new FakeSocket(url),
    ...options,
  });
  connection.start();
  registerConnection(connection);
  const socket = FakeSocket.latest();
  socket.hello(user);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = createApi({ fetch: () => Promise.reject(new Error('no HTTP in this test')) });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <PetalProvider value={{ connection, api, user }}>{ui}</PetalProvider>
    </QueryClientProvider>,
  );
  return { ...result, connection, socket, queryClient };
}
