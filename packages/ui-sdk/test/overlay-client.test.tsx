import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { PetalConnection } from '../src/client/connection.ts';
import { ConnectionProvider, registerConnection } from '../src/client/context.tsx';
import { createOverlayClient } from '../src/client/plugin-client.ts';
import { FakeSocket } from './fake-socket.ts';

const stream = defineContract({
  id: 'stream',
  version: '1.0.0',
  events: { follow: { schema: z.object({ user: z.string() }), expose: ['overlay'] } },
});
const alerts = defineContract({
  id: 'alerts',
  version: '1.0.0',
  rpc: {
    recent: { input: z.object({}), output: z.array(z.string()), expose: { overlay: true } },
  },
  overlays: {
    box: {
      dependencies: [stream],
      config: z.object({}),
      events: ['stream.follow'],
      rpc: ['alerts.recent'],
    },
  },
});
const box = createOverlayClient(alerts, 'box');

function Box() {
  const recent = box.useRpc('alerts.recent', {});
  const [last, setLast] = useState('nobody');
  box.useEvent('stream.follow', (event) => {
    setLast(event.payload.user);
  });
  return (
    <p>
      recent: {recent.data?.join(', ') ?? '…'} / last: {last}
    </p>
  );
}

describe('createOverlayClient', () => {
  it('knows its plugin and the overlay dependencies', () => {
    expect(box.pluginId).toBe('alerts');
    expect(box.dependencies).toEqual(['stream']);
  });

  it('works under a ConnectionProvider, without a panel session', async () => {
    FakeSocket.reset();
    const connection = new PetalConnection({
      url: 'ws://host.test/ws?t=x',
      createSocket: (url) => new FakeSocket(url),
    });
    registerConnection(connection);
    connection.start();
    const socket = FakeSocket.latest();
    socket.receive({
      type: 'hello',
      identity: {
        kind: 'overlay',
        instanceId: 'i1',
        pluginId: 'alerts',
        overlay: 'box',
        preview: false,
      },
      overlay: { config: {}, bundle: null },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionProvider connection={connection}>
          <Box />
        </ConnectionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'alerts.recent' }]);
      expect(socket.ofType('subscribe')).toMatchObject([{ event: 'stream.follow' }]);
    });
    act(() => {
      socket.answer('rpc', ['a', 'b']);
      socket.receive({
        type: 'event',
        envelope: {
          id: 'e1',
          name: 'stream.follow',
          payload: { user: 'mia' },
          source: 'stream',
          timestamp: 1,
          depth: 0,
        },
      });
    });
    expect(await screen.findByText('recent: a, b / last: mia')).toBeTruthy();
    connection.stop();
  });
});
