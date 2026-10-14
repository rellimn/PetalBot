import type { EventEnvelope } from '@petalbot/sdk';
import { createStore, type ReadonlyStore } from '../store.ts';
import { ClientError } from './errors.ts';
import type {
  DiscoveryProblem,
  Identity,
  LogEntry,
  OverlayBundleInfo,
  OverlaySession,
  PluginInfo,
  PluginList,
} from './types.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';

/** What the connection knows; a new object after every change (read it with `useStore`). */
export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Every known plugin by id. A change replaces only the changed plugin's entry. */
  readonly plugins: ReadonlyMap<string, PluginInfo>;
  /** True once the plugin list was loaded at least once (an empty list is then really empty). */
  readonly pluginsLoaded: boolean;
  readonly problems: readonly DiscoveryProblem[];
  /** Overlay connections: the instance's config and bundle; undefined on panel connections. */
  readonly overlay: OverlaySession | undefined;
}

/** The WebSocket members the connection uses; the browser's WebSocket satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface ConnectionOptions {
  /** e.g. `wss://bot.example.com/ws`. */
  readonly url: string;
  /** Default: `new WebSocket(url)`. */
  readonly createSocket?: (url: string) => SocketLike;
  /** Loads the plugin list after every (re)connect. Without it, plugins are not tracked. */
  readonly loadPlugins?: () => Promise<PluginList>;
  /** Asked after an attempt failed before the server greeted; 'ended' stops reconnecting. */
  readonly probe?: () => Promise<'retry' | 'ended'>;
  readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number };
  readonly callTimeoutMs?: number;
}

interface Reply {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface Request {
  handle(reply: Reply): void;
  /** The request will never be answered. */
  abandon(error: ClientError): void;
}

interface Subscription {
  readonly listeners: Set<(event: EventEnvelope) => void>;
  state: 'pending' | 'active' | 'unavailable' | 'refused';
}

/** 4001: the panel session ended; 4003: the overlay token was revoked or rotated. */
const ENDING_CODES: ReadonlySet<number> = new Set([4001, 4003]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function notify<T>(listeners: Iterable<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      console.error('PetalBot: a listener failed', error);
    }
  }
}

/**
 * The browser end of `/ws`: one socket per page, shared by the shell and every plugin.
 * Reconnects with backoff, re-subscribes, queues calls while offline and tracks plugin states.
 */
export class PetalConnection {
  readonly #url: string;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #loadPlugins: (() => Promise<PluginList>) | undefined;
  readonly #probe: (() => Promise<'retry' | 'ended'>) | undefined;
  readonly #initialMs: number;
  readonly #maxMs: number;
  readonly #callTimeoutMs: number;

  readonly #state = createStore<ConnectionState>(
    {
      status: 'connecting',
      plugins: new Map(),
      pluginsLoaded: false,
      problems: [],
      overlay: undefined,
    },
    { name: 'petalbot/connection' },
  );
  #identity: Identity | undefined;
  #socket: SocketLike | undefined;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #nextId = 1;
  #refreshSeq = 0;
  /** Plugin updates that arrived while the list was loading (applied on top of it). */
  #buffered: (PluginInfo | string)[] | undefined;
  #outbox: { readonly id: string; readonly text: string; readonly request: Request }[] = [];

  readonly #requests = new Map<string, Request>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #logListeners = new Set<(entry: LogEntry) => void>();
  readonly #inspectListeners = new Set<(event: EventEnvelope) => void>();

  constructor(options: ConnectionOptions) {
    this.#url = options.url;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#loadPlugins = options.loadPlugins;
    this.#probe = options.probe;
    this.#initialMs = options.backoff?.initialMs ?? 500;
    this.#maxMs = options.backoff?.maxMs ?? 10_000;
    this.#callTimeoutMs = options.callTimeoutMs ?? 15_000;
  }

  /** Status, plugins and problems as one store: `useStore(connection.state, (s) => s.status)`. */
  get state(): ReadonlyStore<ConnectionState> {
    return this.#state;
  }

  get status(): ConnectionStatus {
    return this.#state.get().status;
  }

  /** Who the server says we are; set after the first greeting. */
  get identity(): Identity | undefined {
    return this.#identity;
  }

  get plugins(): ReadonlyMap<string, PluginInfo> {
    return this.#state.get().plugins;
  }

  get problems(): readonly DiscoveryProblem[] {
    return this.#state.get().problems;
  }

  /** True once the plugin list was loaded at least once (an empty list is then really empty). */
  get pluginsLoaded(): boolean {
    return this.#state.get().pluginsLoaded;
  }

  /** Overlay connections: the instance's config and bundle; a new object after every change. */
  get overlay(): OverlaySession | undefined {
    return this.#state.get().overlay;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  /** Closes for good: no reconnect, pending calls fail with `unavailable`. */
  stop(): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#abandonAll(new ClientError('unavailable', 'The connection was closed'));
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, 'Closed by the panel');
  }

  /** Connects again after the session ended (the user logged in again). */
  restart(): void {
    if (this.status !== 'ended') return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#setStatus('connecting');
    this.#connect();
  }

  /** Receives `event` while at least one listener is subscribed. */
  subscribe(event: string, listener: (event: EventEnvelope) => void): () => void {
    let subscription = this.#subscriptions.get(event);
    if (!subscription) {
      subscription = { listeners: new Set(), state: 'pending' };
      this.#subscriptions.set(event, subscription);
      this.#sendSubscribe(event, subscription);
    }
    const current = subscription;
    current.listeners.add(listener);
    return () => {
      if (!current.listeners.delete(listener) || current.listeners.size > 0) return;
      if (this.#subscriptions.get(event) !== current) return;
      this.#subscriptions.delete(event);
      if (this.status === 'open') {
        this.#socket?.send(JSON.stringify({ type: 'unsubscribe', id: this.#id(), event }));
      }
    };
  }

  /** Calls an RPC. Calls made while offline are sent once the connection is back. */
  call(name: string, input: unknown): Promise<unknown> {
    if (this.status === 'ended') {
      return Promise.reject(new ClientError('unauthorized', 'The session ended'));
    }
    return new Promise((resolve, reject) => {
      const id = this.#id();
      let text: string;
      try {
        text = JSON.stringify({ type: 'rpc', id, name, input });
      } catch {
        reject(new ClientError('validation', `The input of ${name} cannot be sent as JSON`));
        return;
      }
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        this.#outbox = this.#outbox.filter((entry) => entry.id !== id);
        reject(new ClientError('timeout', `${name} did not answer in time`));
      }, this.#callTimeoutMs);
      const request: Request = {
        handle: (reply) => {
          clearTimeout(timer);
          if (reply.error) reject(new ClientError(reply.error.code, reply.error.message));
          else resolve(reply.result);
        },
        abandon: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      if (this.status === 'open' && this.#socket) {
        this.#requests.set(id, request);
        this.#socket.send(text);
      } else {
        this.#outbox.push({ id, text, request });
      }
    });
  }

  /** Live log entries (owners only). */
  streamLogs(listener: (entry: LogEntry) => void): () => void {
    return this.#stream('logs', this.#logListeners, listener);
  }

  /** Every event, for the inspector (owners only). */
  inspect(listener: (event: EventEnvelope) => void): () => void {
    return this.#stream('inspect', this.#inspectListeners, listener);
  }

  /** Reloads the plugin list (also done after every reconnect). */
  async refreshPlugins(): Promise<void> {
    const load = this.#loadPlugins;
    if (!load) return;
    const seq = ++this.#refreshSeq;
    this.#buffered = [];
    let list: PluginList;
    try {
      list = await load();
    } catch {
      if (seq === this.#refreshSeq) this.#buffered = undefined;
      return;
    }
    if (seq !== this.#refreshSeq) return;
    const next = new Map(list.plugins.map((info) => [info.id, info]));
    for (const update of this.#buffered) {
      if (typeof update === 'string') next.delete(update);
      else next.set(update.id, update);
    }
    this.#buffered = undefined;
    this.#state.set({ plugins: next, problems: list.problems, pluginsLoaded: true });
  }

  #id(): string {
    return String(this.#nextId++);
  }

  #connect(): void {
    this.#clearRetry();
    const socket = this.#createSocket(this.#url);
    this.#socket = socket;
    let greeted = false;
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (this.#handle(event.data) === 'hello') greeted = true;
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#closed(event.code, greeted);
    };
    socket.onerror = () => undefined; // onclose follows
  }

  #closed(code: number, greeted: boolean): void {
    if (this.#stopped) return;
    if (ENDING_CODES.has(code)) {
      this.#end();
      return;
    }
    this.#abandonSent(new ClientError('unavailable', 'The connection was lost'));
    this.#setStatus(this.#identity === undefined ? 'connecting' : 'reconnecting');
    if (!greeted && this.#probe) {
      this.#probe().then(
        (verdict) => {
          if (verdict === 'ended') this.#end();
          else this.#scheduleRetry();
        },
        () => {
          this.#scheduleRetry();
        },
      );
      return;
    }
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.status === 'ended') return;
    const delay = Math.min(this.#initialMs * 2 ** this.#attempt, this.#maxMs);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#connect();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #end(): void {
    this.#clearRetry();
    this.#setStatus('ended');
    this.#abandonAll(new ClientError('unauthorized', 'The session ended'));
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #abandonSent(error: ClientError): void {
    const requests = [...this.#requests.values()];
    this.#requests.clear();
    for (const request of requests) request.abandon(error);
  }

  #abandonAll(error: ClientError): void {
    this.#abandonSent(error);
    const queued = this.#outbox;
    this.#outbox = [];
    for (const entry of queued) entry.request.abandon(error);
  }

  /** Handles one frame; returns its type. */
  #handle(data: unknown): string | undefined {
    if (typeof data !== 'string') return undefined;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (!isRecord(message) || typeof message.type !== 'string') return undefined;
    switch (message.type) {
      case 'hello':
        this.#identity = message.identity as Identity;
        if (this.#identity.kind === 'overlay' && isRecord(message.overlay)) {
          this.#setOverlay(message.overlay as unknown as OverlaySession);
        }
        this.#greeted();
        break;
      case 'reply': {
        const id = typeof message.id === 'string' ? message.id : '';
        const request = this.#requests.get(id);
        if (request) {
          this.#requests.delete(id);
          request.handle(message);
        }
        break;
      }
      case 'event': {
        const envelope = message.envelope as EventEnvelope;
        const subscription = this.#subscriptions.get(envelope.name);
        if (subscription) notify(subscription.listeners, envelope);
        break;
      }
      case 'inspect.event':
        notify(this.#inspectListeners, message.envelope as EventEnvelope);
        break;
      case 'log.entry':
        notify(this.#logListeners, message.entry as LogEntry);
        break;
      case 'plugin.state':
        this.#overlayBundle(message.plugin);
        this.#pluginChanged(message.plugin as PluginInfo);
        break;
      case 'overlay.config':
        if (this.overlay && isRecord(message.config)) {
          this.#setOverlay({ ...this.overlay, config: message.config });
        }
        break;
      case 'plugin.removed':
        this.#pluginRemoved(String(message.id));
        break;
    }
    return message.type;
  }

  #greeted(): void {
    this.#attempt = 0;
    this.#setStatus('open');
    const socket = this.#socket;
    if (!socket) return;
    for (const [event, subscription] of this.#subscriptions) {
      subscription.state = 'pending';
      this.#sendSubscribe(event, subscription);
    }
    if (this.#logListeners.size > 0) this.#sendToggle('logs', true);
    if (this.#inspectListeners.size > 0) this.#sendToggle('inspect', true);
    const queued = this.#outbox;
    this.#outbox = [];
    for (const entry of queued) {
      this.#requests.set(entry.id, entry.request);
      socket.send(entry.text);
    }
    void this.refreshPlugins();
  }

  #sendSubscribe(event: string, subscription: Subscription): void {
    const socket = this.#socket;
    if (this.status !== 'open' || !socket) return;
    const id = this.#id();
    this.#requests.set(id, {
      handle: (reply) => {
        if (this.#subscriptions.get(event) !== subscription) return;
        if (!reply.error) {
          subscription.state = 'active';
        } else if (reply.error.code === 'unavailable') {
          subscription.state = 'unavailable';
        } else {
          subscription.state = 'refused';
          console.warn(`PetalBot: cannot subscribe to ${event}: ${reply.error.message}`);
        }
      },
      abandon: () => undefined,
    });
    socket.send(JSON.stringify({ type: 'subscribe', id, event }));
  }

  #stream<T>(
    type: 'logs' | 'inspect',
    listeners: Set<(value: T) => void>,
    listener: (value: T) => void,
  ): () => void {
    listeners.add(listener);
    if (listeners.size === 1) this.#sendToggle(type, true);
    return () => {
      if (!listeners.delete(listener)) return;
      if (listeners.size === 0) this.#sendToggle(type, false);
    };
  }

  #sendToggle(type: 'logs' | 'inspect', enabled: boolean): void {
    if (this.status !== 'open') return;
    this.#socket?.send(JSON.stringify({ type, id: this.#id(), enabled }));
  }

  #pluginChanged(info: PluginInfo): void {
    if (this.#loadPlugins) {
      this.#buffered?.push(info);
      this.#setPlugins(new Map(this.plugins).set(info.id, info));
    }
    if (info.state !== 'running') return;
    for (const [event, subscription] of this.#subscriptions) {
      if (subscription.state === 'unavailable' && event.split('.')[0] === info.id) {
        subscription.state = 'pending';
        this.#sendSubscribe(event, subscription);
      }
    }
  }

  #pluginRemoved(id: string): void {
    if (!this.#loadPlugins) return;
    this.#buffered?.push(id);
    const next = new Map(this.plugins);
    next.delete(id);
    this.#setPlugins(next);
  }

  /** An overlay's `plugin.state` carries its bundle (null while it cannot run). */
  #overlayBundle(plugin: unknown): void {
    const current = this.overlay;
    if (this.#identity?.kind !== 'overlay' || !current || !isRecord(plugin)) return;
    const bundle = isRecord(plugin.bundle) ? (plugin.bundle as unknown as OverlayBundleInfo) : null;
    if ((bundle?.hash ?? null) === (current.bundle?.hash ?? null)) return;
    this.#setOverlay({ ...current, bundle });
  }

  #setOverlay(next: OverlaySession): void {
    this.#state.set({ overlay: next });
  }

  #setPlugins(next: ReadonlyMap<string, PluginInfo>): void {
    this.#state.set({ plugins: next });
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.#state.set({ status });
  }
}
