import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import {
  PetalConnection,
  createOverlayClient,
  defineOverlay,
  registerConnection,
  type OverlayBundleInfo,
  type OverlayConfig,
  type OverlayProps,
} from '@petalbot/ui-sdk';
import { OverlayHost } from '../src/OverlayHost.tsx';
import { OverlayRuntime } from '../src/runtime.ts';
import { FakeSocket } from './fake-socket.ts';

const counter = defineContract({
  id: 'counter',
  version: '1.0.0',
  events: { changed: { schema: z.object({ value: z.number() }), expose: ['overlay'] } },
  overlays: {
    display: {
      config: z.object({ label: z.string().default('Count') }),
      events: ['counter.changed'],
      rpc: [],
    },
  },
});
const display = createOverlayClient(counter, 'display');

function Display({ config }: OverlayProps<OverlayConfig<typeof counter, 'display'>>) {
  const [value, setValue] = useState(0);
  display.counter.changed.useEvent((event) => {
    setValue(event.payload.value);
  });
  return (
    <p>
      {config.label}: {value}
    </p>
  );
}

const definition = defineOverlay(counter, 'display', { component: Display });

const bundle = (hash: string): OverlayBundleInfo => ({
  hash,
  entry: `/plugins/counter/overlays/display/${hash}/display.js`,
  styles: [],
});

function setup() {
  FakeSocket.reset();
  const connection = new PetalConnection({
    url: 'ws://host.test/ws?t=x',
    createSocket: (url) => new FakeSocket(url),
  });
  registerConnection(connection);
  const imported: string[] = [];
  const reload = vi.fn();
  const runtime = new OverlayRuntime({
    pluginId: 'counter',
    overlay: 'display',
    importModule: (url) => {
      imported.push(url);
      return Promise.resolve({ default: definition });
    },
    reload,
  });
  const stopFollowing = runtime.follow(connection);
  connection.start();
  const socket = FakeSocket.latest();
  render(<OverlayHost connection={connection} runtime={runtime} queryClient={new QueryClient()} />);
  return {
    socket,
    imported,
    reload,
    hello(config: Record<string, unknown>, initial: OverlayBundleInfo | null) {
      act(() => {
        socket.receive({
          type: 'hello',
          identity: {
            kind: 'overlay',
            instanceId: 'i1',
            pluginId: 'counter',
            overlay: 'display',
            preview: false,
          },
          overlay: { config, bundle: initial },
        });
      });
    },
    state(state: string, next: OverlayBundleInfo | null) {
      act(() => {
        socket.receive({ type: 'plugin.state', plugin: { id: 'counter', state, bundle: next } });
      });
    },
    finish() {
      stopFollowing();
      connection.stop();
    },
  };
}

describe('OverlayHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the overlay with its config defaults and live events', async () => {
    const host = setup();
    host.hello({}, bundle('h1'));
    expect(await screen.findByText('Count: 0')).toBeTruthy();
    await waitFor(() => {
      expect(host.socket.ofType('subscribe')).toMatchObject([{ event: 'counter.changed' }]);
    });
    act(() => {
      host.socket.answer('subscribe');
      host.socket.receive({
        type: 'event',
        envelope: {
          id: 'e1',
          name: 'counter.changed',
          payload: { value: 5 },
          source: 'counter',
          timestamp: 1,
          depth: 0,
        },
      });
    });
    expect(await screen.findByText('Count: 5')).toBeTruthy();
    host.finish();
  });

  it('re-renders with a new config without reconnecting', async () => {
    const host = setup();
    host.hello({ label: 'Coins' }, bundle('h1'));
    expect(await screen.findByText('Coins: 0')).toBeTruthy();
    act(() => {
      host.socket.receive({ type: 'overlay.config', config: { label: 'Gems' } });
    });
    expect(await screen.findByText('Gems: 0')).toBeTruthy();
    expect(FakeSocket.all).toHaveLength(1);
    host.finish();
  });

  it('empties for good when the token is revoked or rotated', async () => {
    const host = setup();
    host.hello({}, bundle('h1'));
    expect(await screen.findByText('Count: 0')).toBeTruthy();
    act(() => {
      host.socket.onclose?.(new CloseEvent('close', { code: 4003 }));
    });
    expect(screen.queryByText('Count: 0')).toBeNull();
    expect(FakeSocket.all).toHaveLength(1);
    host.finish();
  });

  it('empties while the plugin is stopped and comes back without a reload', async () => {
    const host = setup();
    host.hello({}, bundle('h1'));
    expect(await screen.findByText('Count: 0')).toBeTruthy();
    host.state('stopping', null);
    expect(screen.queryByText('Count: 0')).toBeNull();
    host.state('running', bundle('h1'));
    expect(await screen.findByText('Count: 0')).toBeTruthy();
    expect(host.imported).toHaveLength(1);
    expect(host.reload).not.toHaveBeenCalled();
    host.finish();
  });

  it('reloads the page once when the bundle changes', async () => {
    const host = setup();
    host.hello({}, bundle('h1'));
    expect(await screen.findByText('Count: 0')).toBeTruthy();
    host.state('running', bundle('h2'));
    host.state('running', bundle('h3'));
    expect(host.reload).toHaveBeenCalledTimes(1);
    host.finish();
  });

  it('renders nothing when the stored config no longer parses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = setup();
    host.hello({ label: 42 }, bundle('h1'));
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('config of this instance does not fit') as string,
        expect.anything(),
      );
    });
    expect(screen.queryByText(/: 0$/)).toBeNull();
    host.finish();
  });

  it('renders nothing before the server greeted', () => {
    const host = setup();
    expect(document.body.textContent).toBe('');
    host.finish();
  });
});
