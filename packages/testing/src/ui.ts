import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach } from 'vitest';
import type { PanelUser } from '@petalbot/sdk';
import {
  PetalConnection,
  PetalProvider,
  Toaster,
  createApi,
  registerConnection,
  type SocketLike,
} from '@petalbot/ui-sdk';

// Tests rendered through this helper clean up after themselves.
afterEach(() => {
  cleanup();
});

export type Frame = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly id?: string;
};

/** The server side of the fake socket a plugin UI test talks to. */
export interface FakeServer {
  /** Every frame the UI sent, in order. */
  readonly sent: readonly Frame[];
  /** The `rpc` frames for `name`. */
  calls(name: string): Frame[];
  /** Answers the last call of `name` with `result` (as the server would encode it: JSON). */
  answer(name: string, result: unknown): void;
  /** Fails the last call of `name`. */
  fail(name: string, code: string, message: string): void;
  /** Delivers an event to the UI's subscriptions. */
  emit(name: string, payload: unknown): void;
}

class FakeSocket implements SocketLike {
  readonly sent: Frame[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame);
  }

  close(): void {
    // the test decides when the server closes
  }

  receive(message: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

const defaultUser: PanelUser = { id: 'test-user', name: 'Tester', role: 'owner' };

/**
 * Renders plugin UI (a page, a widget or an overlay component) against a fake PetalBot server:
 * an open connection, a panel user, a QueryClient and a Toaster. Drive the server with `server`.
 */
export function renderPluginUi(
  ui: ReactNode,
  options: { readonly user?: PanelUser } = {},
): RenderResult & { readonly server: FakeServer; readonly queryClient: QueryClient } {
  const user = options.user ?? defaultUser;
  let socket: FakeSocket | undefined;
  const connection = new PetalConnection({
    url: 'ws://plugin.test/ws',
    createSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  connection.start();
  registerConnection(connection);
  if (!socket) throw new Error('renderPluginUi: the connection did not open a socket');
  const open = socket;
  open.readyState = 1;
  open.onopen?.(new Event('open'));
  open.receive({ type: 'hello', identity: { kind: 'panel', user } });
  let event = 0;
  const lastCall = (name: string): Frame => {
    const call = open.sent.filter((frame) => frame.type === 'rpc' && frame.name === name).at(-1);
    if (call?.id === undefined) throw new Error(`renderPluginUi: no call of ${name} to answer`);
    return call;
  };
  const server: FakeServer = {
    sent: open.sent,
    calls: (name) => open.sent.filter((frame) => frame.type === 'rpc' && frame.name === name),
    answer(name, result) {
      open.receive({ type: 'reply', id: lastCall(name).id, result });
    },
    fail(name, code, message) {
      open.receive({ type: 'reply', id: lastCall(name).id, error: { code, message } });
    },
    emit(name, payload) {
      event += 1;
      open.receive({
        type: 'event',
        envelope: {
          id: `e${String(event)}`,
          name,
          payload,
          source: name.slice(0, name.indexOf('.')),
          timestamp: Date.now(),
          depth: 0,
        },
      });
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = createApi({ fetch: () => Promise.reject(new Error('renderPluginUi: no HTTP')) });
  const result = render(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(PetalProvider, {
        value: { connection, api, user },
        children: createElement(Toaster, { children: ui }),
      }),
    }),
  );
  return { ...result, server, queryClient };
}
