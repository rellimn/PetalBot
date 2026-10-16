/**
 * The chat domain: one chat API over every platform.
 *
 * Consumers call `chat.send`, `chat.reply`, `chat.broadcast`, `chat.delete` and `chat.timeout`
 * and listen to `chat.message`; they never see a platform. Platform plugins (twitch, later
 * youtube, kick) implement the `chat.platform` provider slot once per connection and feed
 * messages in through `chat.ingest`.
 *
 * Runs everywhere (server, panel, other plugins), so it imports only zod and @petalbot/sdk.
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { z } from 'zod';
import { Result, defineContract } from '@petalbot/sdk';

/** `twitch`, `youtube`, ...: open, so a new platform changes no union. */
export const PlatformId = z.string().regex(/^[a-z][a-z0-9-]*$/);
/** `<platform>:<channel>`, e.g. `twitch:roman`. */
export const ConnectionId = z.string().regex(/^[a-z][a-z0-9-]*:.+$/);

/** Where a message came from. */
export const Source = z.object({ platform: PlatformId, connection: ConnectionId });
export type Source = z.output<typeof Source>;

/** Who to act on: a connection, or a platform's default connection. */
export const Target = z.union([
  z.object({ connection: ConnectionId }),
  z.object({ platform: PlatformId }),
]);
export type Target = z.output<typeof Target>;

export const ChatUser = z.object({
  /** The platform's stable user id. */
  id: z.string().min(1),
  login: z.string(),
  displayName: z.string(),
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

/** A message of `chat.recent`: deleted ones stay, marked. */
export const RecentMessage = ChatMessage.extend({ deleted: z.boolean() });
export type RecentMessage = z.output<typeof RecentMessage>;

/** The methods a connection's provider implements; `capabilities` lists them. */
export const Capability = z.enum(['send', 'reply', 'delete', 'timeout']);
export type Capability = z.output<typeof Capability>;

/** What a platform announces with `chat.registerConnection`. */
export const ConnectionRegistration = z.object({
  id: ConnectionId,
  platform: PlatformId,
  /** The platform's channel login or handle. */
  channel: z.string().min(1),
  displayName: z.string().min(1),
  /** The connection `{ platform }` targets resolve to. */
  isDefault: z.boolean(),
});

export const ConnectionInfo = ConnectionRegistration.extend({
  capabilities: z.array(Capability),
});
export type ConnectionInfo = z.output<typeof ConnectionInfo>;

/** Message text: trimmed, never empty. Platforms reject what is too long for them. */
const Text = z.string().trim().min(1);

const Sent = z.object({ messageId: z.string() });
const SendResult = Result(Sent);
const ReplyResult = Result(Sent.extend({ delivery: z.enum(['native', 'mention']) }));
const Done = Result(z.object({}));

/** The message a reply answers: a whole `ChatMessage` fits. */
const ReplyTarget = z.object({ id: z.string().min(1), source: Source, user: ChatUser });

export const chatContract = defineContract({
  id: 'chat',
  version: '1.0.0',

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
     * (the caller gets `forbidden`). `caller` is the calling plugin's id, or `client` for the
     * panel.
     */
    beforeSend: {
      input: z.object({
        connection: ConnectionId,
        text: Text,
        replyTo: z.string().optional(),
        caller: z.string(),
      }),
    },
  },

  rpc: {
    send: {
      input: z.object({ target: Target, text: Text }),
      output: SendResult,
      expose: { panel: 'mod' },
    },
    /** Replies natively where the platform can, else the platform mentions the author. */
    reply: { input: z.object({ to: ReplyTarget, text: Text }), output: ReplyResult },
    /** One result per connection; no filter means every connection. */
    broadcast: {
      input: z.object({
        text: Text,
        platforms: z.array(PlatformId).optional(),
        connections: z.array(ConnectionId).optional(),
      }),
      output: z.record(ConnectionId, SendResult),
    },
    delete: { input: z.object({ target: Target, messageId: z.string().min(1) }), output: Done },
    timeout: {
      input: z.object({
        target: Target,
        userId: z.string().min(1),
        seconds: z.number().int().min(1),
        reason: z.string().max(500).optional(),
      }),
      output: Done,
    },
    connections: { kind: 'query', output: z.array(ConnectionInfo), expose: { panel: 'mod' } },
    /** The last 50 messages since chat started, oldest first. */
    recent: { kind: 'query', output: z.array(RecentMessage), expose: { panel: 'mod' } },

    // For platform plugins only, from the plugin that provides the connection.
    registerConnection: { input: ConnectionRegistration, output: z.object({}) },
    ingest: { input: ChatMessage, output: z.object({}) },
    ingestDeleted: {
      input: z.object({ source: Source, messageId: z.string().min(1) }),
      output: z.object({}),
    },
  },

  providers: {
    /** One provider per connection, keyed by its id. Every method is optional. */
    platform: {
      send: { input: z.object({ text: z.string() }), output: SendResult },
      /** The platform owns the fallback: mention syntax differs per platform. */
      reply: {
        input: z.object({ to: z.object({ id: z.string(), user: ChatUser }), text: z.string() }),
        output: ReplyResult,
      },
      delete: { input: z.object({ messageId: z.string() }), output: Done },
      timeout: {
        input: z.object({
          userId: z.string(),
          seconds: z.number().int(),
          reason: z.string().optional(),
        }),
        output: Done,
      },
    },
  },

  widgets: {
    chat: {},
  },
});
