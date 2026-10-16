/**
 * The stream domain: community events (follows, subscriptions, raids, support, going live) from
 * every platform, in one shape.
 *
 * Consumers listen to `stream.*` events. Platform plugins provide `stream.platform` once per
 * connection (no methods yet; it ties the connection to the plugin), announce it with
 * `stream.registerConnection` and feed events in through `stream.ingest`.
 *
 * Runs everywhere (server, panel, other plugins), so it imports only zod and @petalbot/sdk.
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';

export const PlatformId = z.string().regex(/^[a-z][a-z0-9-]*$/);
/** `<platform>:<channel>`, e.g. `twitch:roman`. */
export const ConnectionId = z.string().regex(/^[a-z][a-z0-9-]*:.+$/);

export const Source = z.object({ platform: PlatformId, connection: ConnectionId });
export type Source = z.output<typeof Source>;

export const StreamUser = z.object({
  /** The platform's stable user id. */
  id: z.string().min(1),
  login: z.string(),
  displayName: z.string(),
});
export type StreamUser = z.output<typeof StreamUser>;

/** 1, 2 or 3 on Twitch (its 1000, 2000, 3000). */
const Tier = z.number().int().min(1);

const Online = z.object({
  source: Source,
  /** When the stream started (milliseconds since the epoch), if the platform tells. */
  since: z.number().int().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
});
const Offline = z.object({ source: Source });
const Follow = z.object({ source: Source, user: StreamUser });
const Subscription = z.object({
  source: Source,
  user: StreamUser,
  tier: Tier,
  /** Total months, when the platform tells (resubscriptions). */
  months: z.number().int().min(1).optional(),
  message: z.string().optional(),
});
const GiftSubscription = z.object({
  source: Source,
  /** Missing for anonymous gifts. */
  gifter: StreamUser.optional(),
  count: z.number().int().min(1),
  tier: Tier,
});
const Raid = z.object({
  source: Source,
  from: StreamUser,
  viewers: z.number().int().min(0),
});
const Support = z.object({
  source: Source,
  /** Missing for anonymous support. */
  user: StreamUser.optional(),
  amount: z.number().positive(),
  /** An ISO code (`EUR`) or a platform currency (`bits`). */
  currency: z.string().min(1),
  message: z.string().optional(),
});

/** What `stream.ingest` takes: one event, by `type`. */
export const StreamEvent = z.discriminatedUnion('type', [
  Online.extend({ type: z.literal('online') }),
  Offline.extend({ type: z.literal('offline') }),
  Follow.extend({ type: z.literal('follow') }),
  Subscription.extend({ type: z.literal('subscription') }),
  GiftSubscription.extend({ type: z.literal('giftSubscription') }),
  Raid.extend({ type: z.literal('raid') }),
  Support.extend({ type: z.literal('support') }),
]);
export type StreamEvent = z.output<typeof StreamEvent>;

/** One entry of `stream.recent`. */
export const Activity = z.object({
  id: z.string(),
  /** Milliseconds since the epoch, when the event arrived. */
  timestamp: z.number().int(),
  event: StreamEvent,
});
export type Activity = z.output<typeof Activity>;

export const ConnectionRegistration = z.object({
  id: ConnectionId,
  platform: PlatformId,
  channel: z.string().min(1),
  displayName: z.string().min(1),
  /** Whether the stream is live right now, so no `stream.online` is needed to say so. */
  live: z.boolean().default(false),
  /** Since when it is live (milliseconds since the epoch). */
  since: z.number().int().optional(),
});

export const ConnectionStatus = z.object({
  live: z.boolean(),
  since: z.number().int().optional(),
});
export type ConnectionStatus = z.output<typeof ConnectionStatus>;

const expose = ['panel'] as const;

export const streamContract = defineContract({
  id: 'stream',
  version: '1.0.0',

  events: {
    online: { schema: Online, expose },
    offline: { schema: Offline, expose },
    follow: { schema: Follow, expose },
    subscription: { schema: Subscription, expose },
    giftSubscription: { schema: GiftSubscription, expose },
    raid: { schema: Raid, expose },
    support: { schema: Support, expose },
    /** A connection was registered, replaced or went away. */
    connectionsChanged: { schema: z.object({}), expose },
  },

  rpc: {
    /** The last 30 events since stream started, newest first. */
    recent: { kind: 'query', output: z.array(Activity), expose: { panel: 'mod' } },
    /** Per registered connection: is it live? */
    status: {
      kind: 'query',
      output: z.record(ConnectionId, ConnectionStatus),
      expose: { panel: 'mod' },
    },

    // For platform plugins only, from the plugin that provides the connection.
    registerConnection: { input: ConnectionRegistration, output: z.object({}) },
    ingest: { input: StreamEvent, output: z.object({}) },
  },

  providers: {
    /** One per connection, keyed by its id. No methods yet: outbound stream operations go here. */
    platform: {},
  },

  widgets: {
    activity: {},
  },
});
