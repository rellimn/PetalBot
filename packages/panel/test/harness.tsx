import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import type { PanelUser } from '@petalbot/sdk';
import {
  PetalConnection,
  createApi,
  registerConnection,
  type DiscoveryProblem,
  type PanelDefinition,
  type PluginInfo,
  type SocketLike,
} from '@petalbot/ui-sdk';
import { App } from '../src/app/App.tsx';
import { loadPlugins } from '../src/app/endpoints.ts';
import { createSession } from '../src/app/session.ts';
import { PanelRegistry } from '../src/plugins/registry.ts';

export const ownerUser: PanelUser = { id: 'u-owner', name: 'roman', role: 'owner' };
export const modUser: PanelUser = { id: 'u-mod', name: 'mia', role: 'mod' };

/** A WebSocket stand-in driven from the "server" side. */
export class FakeSocket implements SocketLike {
  static readonly all: FakeSocket[] = [];
  readonly sent: (Record<string, unknown> & { type: string; id?: string })[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    FakeSocket.all.push(this);
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.all.at(-1);
    if (!socket) throw new Error('no socket');
    return socket;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown> & { type: string });
  }

  close(): void {
    // nothing: the test decides when the "server" closes
  }

  receive(message: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.onclose?.(new CloseEvent('close', { code }));
  }

  ofType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  answer(
    type: string,
    result: unknown,
    match?: (message: Record<string, unknown>) => boolean,
  ): void {
    const message = this.ofType(type)
      .filter((sent) => match?.(sent) ?? true)
      .at(-1);
    if (message?.id === undefined) throw new Error(`no ${type} to answer`);
    this.receive({ type: 'reply', id: message.id, result });
  }
}

export class Reply {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

export const reply = (status: number, body: unknown): Reply => new Reply(status, body);

export const apiError = (
  status: number,
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): Reply => reply(status, { error: { code, message, ...extra } });

export type Handler = (request: { readonly body: unknown; readonly url: URL }) => unknown;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Overrides may set optional fields to undefined to leave them out. */
export type PluginOverrides = { readonly [K in keyof PluginInfo]?: PluginInfo[K] | undefined };

export function pluginInfo(id: string, overrides: PluginOverrides = {}): PluginInfo {
  const merged = {
    id,
    version: '1.0.0',
    dir: `/srv/plugins/${id}`,
    state: 'running',
    enabled: true,
    degraded: false,
    dependencies: [],
    optionalDependencies: [],
    hasPanel: true,
    hasSettings: true,
    panel: { entry: `/plugins/${id}/h1/panel.js`, styles: [] },
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as PluginInfo;
}

export interface HarnessOptions {
  readonly path?: string;
  readonly user?: PanelUser;
  readonly plugins?: readonly PluginInfo[];
  readonly problems?: readonly DiscoveryProblem[];
  /** Panel definitions (or module loaders) by plugin id. */
  readonly panels?: Readonly<Record<string, PanelDefinition | (() => Promise<unknown>)>>;
  /** `"METHOD /path"` -> handler; returns the JSON body, a `reply(...)`, or undefined for 204. */
  readonly routes?: Readonly<Record<string, Handler>>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Renders the whole panel against a fake API and a fake socket that is already open. */
export async function renderApp(options: HarnessOptions = {}) {
  FakeSocket.all.length = 0;
  const user = options.user ?? ownerUser;
  let plugins = [...(options.plugins ?? [])];
  const requests: RecordedRequest[] = [];
  const left: string[] = [];
  const routes: Record<string, Handler> = {
    'GET /api/plugins': () => ({ plugins, problems: options.problems ?? [] }),
    'GET /api/me/preferences': () => ({
      darkScheme: 'rose',
      lightScheme: 'light',
      mode: 'system',
      density: 'comfortable',
      activePreset: null,
    }),
    'PUT /api/me/preferences': ({ body }) => body,
    'GET /api/me/presets': () => ({ presets: [] }),
    ...options.routes,
  };
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://panel.test');
    const method = init.method ?? 'GET';
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      return json(404, {
        error: { code: 'not_found', message: `No fake for ${method} ${url.pathname}` },
      });
    }
    const result = await handler({ body, url });
    if (result instanceof Reply) {
      return result.status === 204
        ? new Response(null, { status: 204 })
        : json(result.status, result.body);
    }
    return result === undefined ? new Response(null, { status: 204 }) : json(200, result);
  };

  const session = createSession();
  const api = createApi({
    fetch,
    onUnauthorized: () => {
      session.end();
    },
  });
  const connection = new PetalConnection({
    url: 'ws://panel.test/ws',
    createSocket: () => new FakeSocket(),
    loadPlugins: () => loadPlugins(api),
  });
  registerConnection(connection);
  connection.start();
  const socket = FakeSocket.latest();
  const registry = new PanelRegistry({
    importModule: (url) => {
      const id = url.split('/')[2] ?? '';
      const panel = options.panels?.[id];
      if (panel === undefined) return Promise.reject(new Error(`no fake bundle for ${id}`));
      return typeof panel === 'function' ? panel() : Promise.resolve({ default: panel });
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
  render(
    <App
      me={{ user, devAuth: false }}
      api={api}
      connection={connection}
      session={session}
      registry={registry}
      history={history}
      queryClient={queryClient}
      leave={(url) => {
        left.push(url);
      }}
    />,
  );
  await act(async () => {
    socket.receive({ type: 'hello', identity: { kind: 'panel', user } });
    await Promise.resolve();
  });
  return {
    user,
    socket,
    connection,
    session,
    requests,
    history,
    queryClient,
    left,
    /** Changes a plugin as the server would announce it. */
    setPlugin(info: PluginInfo) {
      plugins = [...plugins.filter((plugin) => plugin.id !== info.id), info];
      act(() => {
        socket.receive({ type: 'plugin.state', plugin: info });
      });
    },
  };
}
