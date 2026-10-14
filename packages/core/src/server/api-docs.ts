import { randomBytes } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { Logger } from '@petalbot/sdk';
import type { AppEnv } from './app.ts';
import { resolveConfig } from './config.ts';
import {
  CLOSE,
  PROTOCOL_LIMITS,
  eventMessage,
  helloMessage,
  overlayConfigMessage,
  inspectEventMessage,
  inspectMessage,
  logEntryMessage,
  logsMessage,
  pluginRemovedMessage,
  pluginStateMessage,
  replyMessage,
  rpcMessage,
  subscribeMessage,
  unsubscribeMessage,
} from './gateway/protocol.ts';
import { createServices } from './services.ts';

/** Version of the documented HTTP and WebSocket APIs (plugin apiVersion 1). */
export const API_VERSION = '1.0.0';

const OPENAPI_DESCRIPTION = [
  'The HTTP API of one PetalBot instance.',
  '',
  '- Authentication: the `petalbot_session` cookie from `/auth/login` -> `/auth/callback`.',
  '- Every non-GET request outside `/api/p/*` must send `Origin` equal to the public URL.',
  '- Errors: `{ "error": { "code", "message", "plugins"? } }`, never a stack trace.',
  '- Validation errors (`code: validation`) may list `issues: [{ path, message }]`.',
  '- Browser navigations (`Accept: text/html`) to `/auth/*` that fail redirect to',
  '  `/login-error?reason=forbidden|expired|failed|unavailable` instead.',
  '- Not listed: `GET /plugins/{pluginId}/{hash}/…` serves the panel bundle of a running plugin',
  '  (panel session required), `GET /plugins/{pluginId}/overlays/{overlay}/{hash}/…` serves its',
  '  overlay bundles (public), and every other unknown GET path serves the panel (SPA fallback).',
  '- Also not listed: `GET /overlay/{pluginId}/{overlay}/{instanceId}?t=<token>` serves the overlay',
  '  host page for OBS (the token is checked by the WebSocket), `GET /overlay/_/…` its files.',
  '- Request bodies are limited to 1 MiB.',
  '- Plugin routes live under `/api/p/{pluginId}/…`. They are registered at runtime with',
  '  `ctx.http.route` and are not listed here; see docs/api/plugin-api.md.',
].join('\n');

const ASYNCAPI_DESCRIPTION = [
  'The WebSocket API of one PetalBot instance at `/ws`',
  '',
  '- Upgrade: `Origin` must equal the public URL. The panel authenticates with the',
  "  `petalbot_session` cookie, an overlay with `?t=<token>`, and the panel's live preview with",
  '  `?preview=<instanceId>` plus an owner session. Refusals are plain HTTP 401/403/404.',
  '- Every client message has an `id`; the server answers each with one `reply` carrying either',
  '  `result` or `error: { code, message }`.',
  '- Error codes: invalid_message, forbidden, not_found, validation, unavailable, timeout, busy, internal.',
  `- Limits: frames ≤ ${String(PROTOCOL_LIMITS.maxMessageBytes)} bytes, ≤ ${String(PROTOCOL_LIMITS.maxConcurrentRpcs)} concurrent RPCs per socket, ping every ${String(PROTOCOL_LIMITS.heartbeatMs / 1000)} s.`,
  `- Close codes: ${String(CLOSE.serverShutdown)} shutdown, ${String(CLOSE.invalidData)} malformed data, ${String(CLOSE.serverError)} send failure, ${String(CLOSE.slowConsumer)} too slow, ${String(CLOSE.sessionEnded)} session ended, ${String(CLOSE.overlayRevoked)} overlay token revoked or rotated.`,
  '- Clients reconnect with exponential backoff (capped at 10 s) and subscribe again.',
  '  Subscribing to an event of a stopped plugin answers `unavailable`; subscribe again',
  '  when `plugin.state` reports it running.',
].join('\n');

interface MessageDoc {
  readonly schema: z.ZodType;
  /** From the server's point of view. */
  readonly action: 'receive' | 'send';
  readonly summary: string;
}

const MESSAGES: Readonly<Record<string, MessageDoc>> = {
  subscribe: {
    schema: subscribeMessage,
    action: 'receive',
    summary: 'Subscribe to an exposed event. Overlays only to events their declaration lists.',
  },
  unsubscribe: {
    schema: unsubscribeMessage,
    action: 'receive',
    summary: 'Stop receiving an event.',
  },
  rpc: {
    schema: rpcMessage,
    action: 'receive',
    summary: 'Call an exposed RPC. The panel needs the role in expose.panel.',
  },
  inspect: {
    schema: inspectMessage,
    action: 'receive',
    summary: 'Owners only: receive every event as inspect.event (enabled: false stops).',
  },
  logs: {
    schema: logsMessage,
    action: 'receive',
    summary: 'Owners only: receive every new log entry as log.entry (enabled: false stops).',
  },
  logEntry: {
    schema: logEntryMessage,
    action: 'send',
    summary: 'A new log entry, for owners who sent logs.',
  },
  hello: {
    schema: helloMessage,
    action: 'send',
    summary:
      'First message after the upgrade: who the server thinks the client is. Overlays also get their config and bundle.',
  },
  reply: { schema: replyMessage, action: 'send', summary: 'The answer to one client message.' },
  event: { schema: eventMessage, action: 'send', summary: 'An event the client subscribed to.' },
  inspectEvent: {
    schema: inspectEventMessage,
    action: 'send',
    summary: 'Any event, for owners who sent inspect.',
  },
  pluginState: {
    schema: pluginStateMessage,
    action: 'send',
    summary:
      'A plugin changed state. The panel gets the full PluginInfo; an overlay gets { id, state, bundle } of its own plugin (a new bundle hash means new code).',
  },
  pluginRemoved: {
    schema: pluginRemovedMessage,
    action: 'send',
    summary: 'Panel only: a plugin folder disappeared after a rescan.',
  },
  overlayConfig: {
    schema: overlayConfigMessage,
    action: 'send',
    summary: 'Overlays only: the instance config changed (PATCH /api/overlays/{id}).',
  },
};

export function buildOpenApiDocument(app: OpenAPIHono<AppEnv>): unknown {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'PetalBot HTTP API', version: API_VERSION, description: OPENAPI_DESCRIPTION },
  });
}

export function buildAsyncApiDocument(): Record<string, unknown> {
  const entries = Object.entries(MESSAGES);
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'PetalBot WebSocket API',
      version: API_VERSION,
      description: ASYNCAPI_DESCRIPTION,
    },
    defaultContentType: 'application/json',
    servers: {
      petalbot: {
        host: 'bot.example.com',
        protocol: 'wss',
        pathname: '/ws',
        description: 'Same origin as the panel (the configured public URL).',
      },
    },
    channels: {
      ws: {
        address: '/ws',
        messages: Object.fromEntries(
          entries.map(([name]) => [name, { $ref: `#/components/messages/${name}` }]),
        ),
      },
    },
    operations: Object.fromEntries(
      entries.map(([name, doc]) => [
        `${doc.action}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
        {
          action: doc.action,
          channel: { $ref: '#/channels/ws' },
          messages: [{ $ref: `#/channels/ws/messages/${name}` }],
        },
      ]),
    ),
    components: {
      messages: Object.fromEntries(
        entries.map(([name, doc]) => [
          name,
          { name, summary: doc.summary, payload: jsonSchema(doc.schema) },
        ]),
      ),
    },
  };
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }),
  };
  delete json.$schema;
  return json;
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const format = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`;

/** Both generated documents, exactly as they are committed in docs/api/. */
export async function renderApiDocuments(): Promise<
  Readonly<Record<'openapi.json' | 'asyncapi.json', string>>
> {
  const config = resolveConfig(
    {
      publicUrl: 'https://bot.example.com',
      database: ':memory:',
      pluginDirs: [],
      oidc: {
        issuer: 'https://auth.example.com',
        clientId: 'petalbot',
        groups: { 'petalbot-owners': 'owner' },
      },
    },
    {
      PETALBOT_SECRET_KEY: randomBytes(32).toString('base64'),
      PETALBOT_OIDC_CLIENT_SECRET: 'unused',
    },
    '/',
  );
  const services = createServices({ config, logger: silentLogger });
  try {
    return {
      'openapi.json': format(buildOpenApiDocument(services.app)),
      'asyncapi.json': format(buildAsyncApiDocument()),
    };
  } finally {
    await services.close();
  }
}
