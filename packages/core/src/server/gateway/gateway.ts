import { z } from 'zod';
import type { EventEnvelope, Logger, RpcClient } from '@petalbot/sdk';
import type { LogEntry } from '../../log-ring.ts';
import { errorMessage } from '../../names.ts';
import type { OverlayBundleInfo, PluginInfo } from '../../plugin-manager.ts';
import { outsidePlugin } from '../../plugin-scope.ts';
import { toWireError, type WireError } from '../errors.ts';
import type { ClientIdentity } from '../identity.ts';
import { checkCall, checkSubscribe, type ContractLookup } from './access.ts';
import { CLOSE, PROTOCOL_LIMITS, clientMessageSchema, type ServerMessage } from './protocol.ts';

/** What the gateway needs from a socket. `ws` and the tests implement it. */
export interface ClientTransport {
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount: number;
}

export interface GatewayKernel extends ContractLookup {
  tap(fn: (event: EventEnvelope) => void): () => void;
  callFromClient(name: string, input: unknown, client: RpcClient): Promise<unknown>;
}

export interface GatewayPlugins {
  onChange(listener: (info: PluginInfo) => void): () => void;
  onRemoved(listener: (pluginId: string) => void): () => void;
  /** URLs of a running plugin's overlay bundle. */
  overlayBundle(pluginId: string, overlay: string): OverlayBundleInfo | undefined;
}

/** Overlay instance configs (the OverlayInstanceStore). */
export interface GatewayOverlays {
  get(instanceId: string): { readonly config: Readonly<Record<string, unknown>> } | undefined;
  onUpdate(
    listener: (instance: {
      readonly id: string;
      readonly config: Readonly<Record<string, unknown>>;
    }) => void,
  ): () => void;
}

/** Where log entries come from (the LogRing). */
export interface GatewayLogs {
  onEntry(listener: (entry: LogEntry) => void): () => void;
}

export interface ClientGatewayOptions {
  readonly kernel: GatewayKernel;
  readonly plugins: GatewayPlugins;
  readonly logger: Logger;
  readonly logs?: GatewayLogs;
  readonly overlays?: GatewayOverlays;
  readonly maxConcurrentRpcs?: number;
  readonly maxBufferedBytes?: number;
}

export interface ClientConnection {
  readonly identity: ClientIdentity;
  /** Handles one text frame from the client. */
  receive(data: string): void;
  /** Call when the socket has closed. */
  closed(): void;
}

interface Connection {
  readonly identity: ClientIdentity;
  readonly transport: ClientTransport;
  readonly events: Set<string>;
  inspecting: boolean;
  logging: boolean;
  pendingRpcs: number;
  open: boolean;
}

/** Turns WebSocket frames into checked subscriptions and RPC calls */
export class ClientGateway {
  readonly #kernel: GatewayKernel;
  readonly #logger: Logger;
  readonly #maxRpcs: number;
  readonly #maxBuffered: number;
  readonly #connections = new Set<Connection>();
  readonly #disposers: (() => void)[];
  readonly #plugins: GatewayPlugins;
  /** Event names whose payloads could not be encoded (logged once each). */
  readonly #unencodable = new Set<string>();
  readonly #overlays: GatewayOverlays | undefined;
  #deliveringLog = false;

  constructor(options: ClientGatewayOptions) {
    this.#kernel = options.kernel;
    this.#logger = options.logger;
    this.#maxRpcs = options.maxConcurrentRpcs ?? PROTOCOL_LIMITS.maxConcurrentRpcs;
    this.#maxBuffered = options.maxBufferedBytes ?? PROTOCOL_LIMITS.maxBufferedBytes;
    this.#plugins = options.plugins;
    this.#overlays = options.overlays;
    this.#disposers = [
      ...(options.overlays
        ? [
            options.overlays.onUpdate((instance) => {
              this.#configChanged(instance.id, instance.config);
            }),
          ]
        : []),
      // Taps run inside the emitter's call; sending is core work, not the plugin's.
      options.kernel.tap((event) => {
        outsidePlugin(() => {
          this.#deliver(event);
        });
      }),
      options.plugins.onChange((info) => {
        this.#pluginChanged(info);
      }),
      options.plugins.onRemoved((pluginId) => {
        this.#pluginRemoved(pluginId);
      }),
      ...(options.logs
        ? [
            options.logs.onEntry((entry) => {
              this.#deliverLog(entry);
            }),
          ]
        : []),
    ];
  }

  /** Number of open connections. */
  get size(): number {
    return this.#connections.size;
  }

  connect(identity: ClientIdentity, transport: ClientTransport): ClientConnection {
    const connection: Connection = {
      identity,
      transport,
      events: new Set(),
      inspecting: false,
      logging: false,
      pendingRpcs: 0,
      open: true,
    };
    this.#connections.add(connection);
    this.#send(connection, this.#hello(identity));
    return {
      identity,
      receive: (data) => {
        this.#receive(connection, data);
      },
      closed: () => {
        connection.open = false;
        this.#connections.delete(connection);
      },
    };
  }

  closeWhere(predicate: (identity: ClientIdentity) => boolean, code: number, reason: string): void {
    for (const connection of [...this.#connections]) {
      if (predicate(connection.identity)) this.#close(connection, code, reason);
    }
  }

  /** Stops listening to the kernel and the plugin manager. Sockets are the caller's. */
  dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
  }

  #receive(connection: Connection, data: string): void {
    if (!connection.open) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.#close(connection, CLOSE.invalidData, 'Malformed JSON');
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const id = requestIdOf(json);
      if (id === undefined) {
        this.#close(connection, CLOSE.invalidData, 'Malformed message');
        return;
      }
      this.#replyError(connection, id, {
        code: 'invalid_message',
        message: summarize(parsed.error.issues),
      });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'subscribe':
        this.#subscribe(connection, message.id, message.event);
        break;
      case 'unsubscribe':
        connection.events.delete(message.event);
        this.#reply(connection, message.id, null);
        break;
      case 'rpc':
        void this.#call(connection, message.id, message.name, message.input);
        break;
      case 'inspect':
        this.#ownerStream(connection, message.id, 'inspect', message.enabled ?? true);
        break;
      case 'logs':
        this.#ownerStream(connection, message.id, 'logs', message.enabled ?? true);
        break;
    }
  }

  #subscribe(connection: Connection, id: string, event: string): void {
    const access = checkSubscribe(connection.identity, event, this.#kernel);
    if (!access.ok) {
      this.#replyError(connection, id, access);
      return;
    }
    connection.events.add(event);
    this.#reply(connection, id, null);
  }

  #ownerStream(
    connection: Connection,
    id: string,
    stream: 'inspect' | 'logs',
    enabled: boolean,
  ): void {
    const { identity } = connection;
    if (identity.kind !== 'panel' || identity.user.role !== 'owner') {
      this.#replyError(connection, id, {
        code: 'forbidden',
        message:
          stream === 'inspect'
            ? 'The event inspector is for owners only'
            : 'Logs are for owners only',
      });
      return;
    }
    if (stream === 'inspect') connection.inspecting = enabled;
    else connection.logging = enabled;
    this.#reply(connection, id, null);
  }

  #deliverLog(entry: LogEntry): void {
    // Anything logged while delivering (a failed send) is kept in the ring but not sent again:
    // sending it could fail and log again, forever.
    if (this.#deliveringLog) return;
    this.#deliveringLog = true;
    try {
      let text: string | undefined;
      for (const connection of [...this.#connections]) {
        if (!connection.logging) continue;
        text ??= this.#serialize({ type: 'log.entry', entry });
        if (text !== undefined) this.#sendText(connection, text);
      }
    } finally {
      this.#deliveringLog = false;
    }
  }

  async #call(connection: Connection, id: string, name: string, input: unknown): Promise<void> {
    const access = checkCall(connection.identity, name, this.#kernel);
    if (!access.ok) {
      this.#replyError(connection, id, access);
      return;
    }
    if (connection.pendingRpcs >= this.#maxRpcs) {
      this.#replyError(connection, id, {
        code: 'busy',
        message: `At most ${String(this.#maxRpcs)} calls may run at once`,
      });
      return;
    }
    connection.pendingRpcs += 1;
    try {
      const result = await this.#kernel.callFromClient(name, input, clientOf(connection.identity));
      const encoded = this.#encodeResult(name, result);
      if (encoded.ok) this.#reply(connection, id, encoded.value);
      else this.#replyError(connection, id, { code: 'internal', message: encoded.message });
    } catch (error) {
      const wire = toWireError(error);
      if (wire.code === 'internal') {
        this.#logger.error('RPC from a client failed', { rpc: name, error: errorMessage(error) });
      }
      this.#replyError(connection, id, wire);
    } finally {
      connection.pendingRpcs -= 1;
    }
  }

  #deliver(event: EventEnvelope): void {
    let text: string | undefined;
    let encoded = false;
    let inspectText: string | undefined;
    for (const connection of [...this.#connections]) {
      if (connection.inspecting) {
        inspectText ??= this.#serialize({ type: 'inspect.event', envelope: event });
        if (inspectText !== undefined) this.#sendText(connection, inspectText);
      }
      if (
        connection.events.has(event.name) &&
        // Re-checked on every event: a reloaded contract may no longer expose it.
        checkSubscribe(connection.identity, event.name, this.#kernel).ok
      ) {
        if (!encoded) {
          encoded = true;
          text = this.#eventText(event);
        }
        if (text !== undefined) this.#sendText(connection, text);
      }
    }
  }

  /** An event as browsers get it: its payload encoded with the event's schema (codecs). */
  #eventText(event: EventEnvelope): string | undefined {
    const schema = this.#kernel.eventDef(event.name)?.def.schema;
    let payload: unknown = event.payload;
    if (schema) {
      try {
        // Throws (also z.safeEncode does) on one-way transforms: they cannot reach a browser.
        payload = z.encode(schema, event.payload);
      } catch (error) {
        if (!this.#unencodable.has(event.name)) {
          this.#unencodable.add(event.name);
          this.#logger.error('An event cannot be encoded for browsers', {
            plugin: this.#kernel.eventDef(event.name)?.owner,
            event: event.name,
            error: errorMessage(error),
          });
        }
        return undefined;
      }
    }
    return this.#serialize({ type: 'event', envelope: { ...event, payload } });
  }

  /** An RPC result encoded with the RPC's output schema (codecs), for a browser. */
  #encodeResult(
    name: string,
    result: unknown,
  ):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly message: string } {
    const schema = this.#kernel.rpcDef(name)?.def.output;
    if (!schema) return { ok: true, value: result };
    try {
      return { ok: true, value: z.encode(schema, result) };
    } catch (error) {
      this.#logger.error('An RPC result cannot be encoded for browsers', {
        plugin: this.#kernel.rpcDef(name)?.owner,
        rpc: name,
        error: errorMessage(error),
      });
      return {
        ok: false,
        message: `The result of ${name} cannot be sent to browsers (its schema is not JSON-safe)`,
      };
    }
  }

  #hello(identity: ClientIdentity): ServerMessage {
    if (identity.kind === 'panel') return { type: 'hello', identity: publicIdentity(identity) };
    return {
      type: 'hello',
      identity: publicIdentity(identity),
      overlay: {
        config: this.#overlays?.get(identity.instanceId)?.config ?? {},
        bundle: this.#plugins.overlayBundle(identity.pluginId, identity.overlay) ?? null,
      },
    };
  }

  #configChanged(instanceId: string, config: Readonly<Record<string, unknown>>): void {
    for (const connection of [...this.#connections]) {
      const { identity } = connection;
      if (identity.kind === 'overlay' && identity.instanceId === instanceId) {
        this.#send(connection, { type: 'overlay.config', config });
      }
    }
  }

  #pluginChanged(info: PluginInfo): void {
    for (const connection of [...this.#connections]) {
      const { identity } = connection;
      if (identity.kind === 'panel') {
        this.#send(connection, { type: 'plugin.state', plugin: info });
      } else if (identity.pluginId === info.id) {
        this.#send(connection, {
          type: 'plugin.state',
          plugin: {
            id: info.id,
            state: info.state,
            bundle:
              info.state === 'running'
                ? (this.#plugins.overlayBundle(info.id, identity.overlay) ?? null)
                : null,
          },
        });
      }
    }
  }

  #pluginRemoved(pluginId: string): void {
    for (const connection of [...this.#connections]) {
      if (connection.identity.kind === 'panel') {
        this.#send(connection, { type: 'plugin.removed', id: pluginId });
      }
    }
  }

  #reply(connection: Connection, id: string, result: unknown): void {
    const text = this.#serialize({ type: 'reply', id, result });
    if (text === undefined) {
      this.#replyError(connection, id, {
        code: 'internal',
        message: 'The result cannot be sent as JSON',
      });
      return;
    }
    this.#sendText(connection, text);
  }

  #replyError(connection: Connection, id: string, error: WireError): void {
    this.#send(connection, {
      type: 'reply',
      id,
      error: { code: error.code, message: error.message },
    });
  }

  #send(connection: Connection, message: ServerMessage): void {
    const text = this.#serialize(message);
    if (text !== undefined) this.#sendText(connection, text);
  }

  #serialize(message: ServerMessage): string | undefined {
    try {
      return JSON.stringify(message);
    } catch (error) {
      this.#logger.error('Cannot serialize a message for a client', {
        type: message.type,
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  #sendText(connection: Connection, text: string): void {
    if (!connection.open) return;
    if (connection.transport.bufferedAmount > this.#maxBuffered) {
      this.#close(connection, CLOSE.slowConsumer, 'Client is not reading fast enough');
      return;
    }
    try {
      connection.transport.send(text);
    } catch (error) {
      this.#logger.warn('Sending to a client failed', { error: errorMessage(error) });
      this.#close(connection, CLOSE.serverError, 'Send failed');
    }
  }

  #close(connection: Connection, code: number, reason: string): void {
    if (!connection.open) return;
    connection.open = false;
    this.#connections.delete(connection);
    try {
      connection.transport.close(code, reason);
    } catch (error) {
      this.#logger.warn('Closing a client failed', { error: errorMessage(error) });
    }
  }
}

function requestIdOf(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const id = (json as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : undefined;
}

function summarize(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function clientOf(identity: ClientIdentity): RpcClient {
  return identity.kind === 'panel'
    ? { kind: 'panel', user: identity.user }
    : { kind: 'overlay', instanceId: identity.instanceId };
}

/** The identity as the client may see it (no session id). */
function publicIdentity(identity: ClientIdentity) {
  return identity.kind === 'panel'
    ? { kind: 'panel' as const, user: identity.user }
    : {
        kind: 'overlay' as const,
        instanceId: identity.instanceId,
        pluginId: identity.pluginId,
        overlay: identity.overlay,
        preview: identity.sessionId !== undefined,
      };
}
