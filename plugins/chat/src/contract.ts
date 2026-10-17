/**
 * The chat domain: one chat API over every platform.
 *
 * Consumers call `chat.send`, `chat.reply`, `chat.broadcast`, `chat.delete` and `chat.timeout`
 * and listen to `chat.message`; they never see a platform. Platform plugins (twitch, later
 * youtube, kick) provide the `chat.platform` slot once per connection, keyed by its connection
 * id, and push messages in through it.
 *
 * Runs everywhere (server, panel, other plugins), so it imports only zod and @petalbot/sdk.
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { z } from 'zod';
import {
  Actor,
  ConnectionId,
  PlatformId,
  PlatformUser,
  Result,
  Source,
  Target,
  defineContract,
  defineFailure,
  rateLimitedFailure,
} from '@petalbot/sdk';

export const ChatUser = PlatformUser.extend({
  badges: z.object({
    broadcaster: z.boolean(),
    moderator: z.boolean(),
    vip: z.boolean(),
    subscriber: z.boolean(),
  }),
});
export type ChatUser = z.output<typeof ChatUser>;

export const ChatMessage = z.object({
  /** The platform's message id, unique per connection. */
  id: z.string().min(1),
  source: Source,
  user: ChatUser,
  text: z.string(),
  /** Set when the message replies to another one (platforms with native replies only). */
  replyTo: z
    .object({ id: z.string(), login: z.string(), displayName: z.string(), text: z.string() })
    .optional(),
  /** Milliseconds since the epoch, as the platform reported it. */
  timestamp: z.number().int(),
  /**
   * Written by the bot's account (also when typed by hand on it). Commands, triggers and stats
   * skip these, so the bot never reacts to itself.
   */
  fromBot: z.boolean(),
});
export type ChatMessage = z.output<typeof ChatMessage>;

/** A message as a platform pushes it: chat adds `source` from the provider's key. */
export const InboundMessage = ChatMessage.omit({ source: true });
export type InboundMessage = z.input<typeof InboundMessage>;

/** A message of `chat.recent`: deleted ones stay, marked. */
export const RecentMessage = ChatMessage.extend({ deleted: z.boolean() });
export type RecentMessage = z.output<typeof RecentMessage>;

/** The methods a connection's provider implements; `capabilities` lists them. */
export const Capability = z.enum(['send', 'reply', 'delete', 'timeout']);
export type Capability = z.output<typeof Capability>;

/** What a platform registers its connection with (the `info` of `chat.platform`). */
export const ChatConnectionInfo = z.object({
  /** The platform's channel login or handle. */
  channel: z.string().min(1),
  displayName: z.string().min(1),
  /** The connection `{ platform }` targets resolve to. */
  isDefault: z.boolean(),
});

/** A connection as `chat.connections` lists it. */
export const ConnectionInfo = ChatConnectionInfo.extend({
  id: ConnectionId,
  platform: PlatformId,
  capabilities: z.array(Capability),
});
export type ConnectionInfo = z.output<typeof ConnectionInfo>;

/** Message text: trimmed, never empty. Platforms reject what is too long for them. */
const Text = z.string().trim().min(1);

/** Domain-owned failures: provider implementers import these definitions. */
export const connectionNotFound = defineFailure({
  code: 'connection-not-found',
  reason: 'not-found',
  details: z.object({ connection: ConnectionId }),
});
export const platformNotConnected = defineFailure({
  code: 'platform-not-connected',
  reason: 'not-found',
  details: z.object({ platform: PlatformId }),
});
export const ambiguousTarget = defineFailure({
  code: 'ambiguous-target',
  reason: 'custom',
  details: z.object({ platform: PlatformId, connections: z.array(ConnectionId).min(2) }),
});
export const unsupportedCapability = defineFailure({
  code: 'unsupported-capability',
  reason: 'unsupported',
  details: z.object({ connection: ConnectionId, capability: Capability }),
});
export const sendVetoed = defineFailure({
  code: 'send-vetoed',
  reason: 'forbidden',
  details: z.object({ connection: ConnectionId, vetoedBy: z.string() }),
});
export const providerError = defineFailure({
  code: 'provider-error',
  reason: 'platform-error',
  details: z.object({ connection: ConnectionId, capability: Capability }),
});
export const permissionDenied = defineFailure({
  code: 'permission-denied',
  reason: 'forbidden',
  details: z.object({}),
});
export const messageRejected = defineFailure({
  code: 'message-rejected',
  reason: 'platform-error',
  /** `duplicate`: the same text as the bot's previous message, which the platform refuses. */
  details: z.object({ cause: z.enum(['duplicate']).optional() }),
});
export const messageNotFound = defineFailure({
  code: 'message-not-found',
  reason: 'not-found',
  details: z.object({ messageId: z.string().min(1) }),
});
export const userNotFound = defineFailure({
  code: 'user-not-found',
  reason: 'not-found',
  details: z.object({ userId: z.string().min(1) }),
});

const resolutionFailures = [connectionNotFound, platformNotConnected, ambiguousTarget] as const;
const sendingFailures = [
  permissionDenied,
  rateLimitedFailure,
  messageRejected,
  providerError,
] as const;
const replyingFailures = [...sendingFailures, messageNotFound] as const;
const deletingFailures = [permissionDenied, messageNotFound, providerError] as const;
const timeoutFailures = [permissionDenied, userNotFound, providerError] as const;
const Sent = z.object({ messageId: z.string() });
const Replied = Sent.extend({ delivery: z.enum(['native', 'mention']) });

export const ProviderSendResult = Result(Sent, sendingFailures);
export const ProviderReplyResult = Result(Replied, replyingFailures);
export const ProviderDeleteResult = Result(z.object({}), deletingFailures);
export const ProviderTimeoutResult = Result(z.object({}), timeoutFailures);
export const SendResult = Result(Sent, [
  ...resolutionFailures,
  unsupportedCapability,
  sendVetoed,
  ...sendingFailures,
]);
export type SendResult = z.output<typeof SendResult>;
export const ReplyResult = Result(Replied, [
  connectionNotFound,
  unsupportedCapability,
  sendVetoed,
  ...replyingFailures,
]);
export const BroadcastItemResult = Result(Sent, [
  connectionNotFound,
  unsupportedCapability,
  sendVetoed,
  ...sendingFailures,
]);
export type BroadcastItemResult = z.output<typeof BroadcastItemResult>;
export const DeleteResult = Result(z.object({}), [
  ...resolutionFailures,
  unsupportedCapability,
  ...deletingFailures,
]);
export const TimeoutResult = Result(z.object({}), [
  ...resolutionFailures,
  unsupportedCapability,
  ...timeoutFailures,
]);

/** The message a reply answers: a whole `ChatMessage` fits. */
const ReplyTarget = z.object({ id: z.string().min(1), source: Source, user: ChatUser });

export const chatContract = defineContract({
  id: 'chat',
  version: '3.1.0',

  events: {
    message: { schema: ChatMessage, expose: ['panel'] },
    messageDeleted: {
      schema: z.object({ source: Source, messageId: z.string() }),
      expose: ['panel'],
    },
    /** A connection was registered, replaced or went away. */
    connectionsChanged: { schema: z.object({}), expose: ['panel'] },
  },

  hooks: {
    /**
     * Runs before every send and reply, once per connection. Taps may rewrite `text` or veto
     * (the caller gets `forbidden`). `actor` is who caused the send: a panel user, a viewer
     * (through a flow) or a plugin.
     */
    beforeSend: {
      input: z.object({
        connection: ConnectionId,
        text: Text,
        replyTo: z.string().optional(),
        actor: Actor,
      }),
    },
  },

  rpc: {
    send: {
      input: z.object({ target: Target, text: Text }),
      output: SendResult,
      expose: { panel: 'mod' },
      // A send may wait up to 10 s in the platform's rate limiter.
      timeoutMs: 15_000,
    },
    /** Replies natively where the platform can, else the platform mentions the author. */
    reply: {
      input: z.object({ to: ReplyTarget, text: Text }),
      output: ReplyResult,
      timeoutMs: 15_000,
      expose: { panel: 'mod' },
    },
    /** One result per connection; no filter means every connection. */
    broadcast: {
      input: z.object({
        text: Text,
        platforms: z.array(PlatformId).optional(),
        connections: z.array(ConnectionId).optional(),
      }),
      output: z.record(ConnectionId, BroadcastItemResult),
      timeoutMs: 15_000,
    },
    delete: {
      input: z.object({ target: Target, messageId: z.string().min(1) }),
      output: DeleteResult,
      expose: { panel: 'mod' },
    },
    timeout: {
      input: z.object({
        target: Target,
        userId: z.string().min(1),
        seconds: z.number().int().min(1),
        reason: z.string().max(500).optional(),
      }),
      output: TimeoutResult,
    },
    connections: { kind: 'query', output: z.array(ConnectionInfo), expose: { panel: 'mod' } },
    /** The last 50 messages since chat started, oldest first. */
    recent: { kind: 'query', output: z.array(RecentMessage), expose: { panel: 'mod' } },
  },

  providers: {
    /**
     * One provider per connection, keyed by its id (`twitch:streamerAccount`); the platform comes from the
     * key. Every method is optional.
     */
    platform: {
      key: ConnectionId,
      info: ChatConnectionInfo,
      methods: {
        send: {
          input: z.object({ text: z.string() }),
          output: ProviderSendResult,
          timeoutMs: 12_000,
        },
        /** The platform owns the fallback: mention syntax differs per platform. */
        reply: {
          input: z.object({ to: z.object({ id: z.string(), user: ChatUser }), text: z.string() }),
          output: ProviderReplyResult,
          timeoutMs: 12_000,
        },
        delete: { input: z.object({ messageId: z.string() }), output: ProviderDeleteResult },
        timeout: {
          input: z.object({
            userId: z.string(),
            seconds: z.number().int(),
            reason: z.string().optional(),
          }),
          output: ProviderTimeoutResult,
        },
      },
      inbound: {
        message: InboundMessage,
        messageDeleted: z.object({ messageId: z.string().min(1) }),
      },
    },
  },

  widgets: {
    chat: {},
  },
});
