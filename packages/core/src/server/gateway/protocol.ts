import { z } from 'zod';
import {
  envelopeSchema,
  logEntrySchema,
  overlayBundleSchema,
  panelUserSchema,
  pluginInfoSchema,
  wireErrorSchema,
} from '../schemas.ts';

export const PROTOCOL_LIMITS = {
  /** Larger inbound frames close the socket (ws close code 1009). */
  maxMessageBytes: 64 * 1024,
  maxConcurrentRpcs: 32,
  /** A client with more unsent data than this is disconnected. */
  maxBufferedBytes: 4 * 1024 * 1024,
  heartbeatMs: 30_000,
} as const;

export const CLOSE = {
  serverShutdown: 1001,
  invalidData: 1007,
  serverError: 1011,
  slowConsumer: 1013,
  sessionEnded: 4001,
  overlayRevoked: 4003,
} as const;

const requestId = z.string().min(1).max(64).describe('Chosen by the client; echoed in the reply');
const memberName = z.string().min(1).max(200);

export const subscribeMessage = z.object({
  type: z.literal('subscribe'),
  id: requestId,
  event: memberName.describe('Qualified event name, e.g. "chat.message"'),
});
export const unsubscribeMessage = z.object({
  type: z.literal('unsubscribe'),
  id: requestId,
  event: memberName,
});
export const rpcMessage = z.object({
  type: z.literal('rpc'),
  id: requestId,
  name: memberName.describe('Qualified RPC name, e.g. "quotes.list"'),
  input: z.unknown(),
});
const streamToggle = z.boolean().optional().describe('false stops the stream; default true');

export const inspectMessage = z.object({
  type: z.literal('inspect'),
  id: requestId,
  enabled: streamToggle,
});
export const logsMessage = z.object({
  type: z.literal('logs'),
  id: requestId,
  enabled: streamToggle,
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessage,
  unsubscribeMessage,
  rpcMessage,
  inspectMessage,
  logsMessage,
]);
export type ClientMessage = z.output<typeof clientMessageSchema>;

const overlayConfig = z
  .record(z.string(), z.unknown())
  .describe("The instance config as stored; the overlay applies its schema's defaults");

export const helloMessage = z.object({
  type: z.literal('hello'),
  identity: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('panel'), user: panelUserSchema }),
    z.object({
      kind: z.literal('overlay'),
      instanceId: z.string(),
      pluginId: z.string(),
      overlay: z.string(),
      preview: z
        .boolean()
        .describe("The panel's live preview (an owner session instead of the token)"),
    }),
  ]),
  overlay: z
    .object({
      config: overlayConfig,
      bundle: overlayBundleSchema
        .nullable()
        .describe('Null while the plugin is not running or has no bundle for this overlay'),
    })
    .optional()
    .describe('Overlays only'),
});
export const replyMessage = z.union([
  z.object({ type: z.literal('reply'), id: z.string(), result: z.unknown() }),
  z.object({ type: z.literal('reply'), id: z.string(), error: wireErrorSchema }),
]);
export const eventMessage = z.object({ type: z.literal('event'), envelope: envelopeSchema });
export const inspectEventMessage = z.object({
  type: z.literal('inspect.event'),
  envelope: envelopeSchema,
});
export const pluginStateMessage = z.object({
  type: z.literal('plugin.state'),
  plugin: z.union([
    pluginInfoSchema,
    z.object({
      id: z.string(),
      state: pluginInfoSchema.shape.state,
      bundle: overlayBundleSchema.nullable().describe('A new hash means new code: reload'),
    }),
  ]),
});
export const overlayConfigMessage = z.object({
  type: z.literal('overlay.config'),
  config: overlayConfig,
});
export const logEntryMessage = z.object({ type: z.literal('log.entry'), entry: logEntrySchema });
export const pluginRemovedMessage = z.object({ type: z.literal('plugin.removed'), id: z.string() });

export type ServerMessage =
  | z.input<typeof helloMessage>
  | z.input<typeof replyMessage>
  | z.input<typeof eventMessage>
  | z.input<typeof inspectEventMessage>
  | z.input<typeof logEntryMessage>
  | z.input<typeof pluginStateMessage>
  | z.input<typeof pluginRemovedMessage>
  | z.input<typeof overlayConfigMessage>;
