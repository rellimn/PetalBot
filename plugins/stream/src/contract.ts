/**
 * The stream domain: community events (follows, subscriptions, raids, support, going live) from
 * every platform, in one shape.
 *
 * Consumers listen to `stream.*` events. Platform plugins provide `stream.platform` once per
 * connection, keyed by its connection id, and push events in through it.
 *
 * Runs everywhere (server, panel, other plugins), so it imports only zod and @petalbot/sdk.
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { z } from 'zod';
import { ConnectionId, PlatformUser, Source, defineContract } from '@petalbot/sdk';

export const StreamUser = PlatformUser;
export type StreamUser = z.output<typeof StreamUser>;

/** 1, 2 or 3 on Twitch (its 1000, 2000, 3000). */
const Tier = z.number().int().min(1);

// Each event's own fields; the events add `source`, the platform's pushes don't carry it.
const OnlineFields = z.object({
  /** When the stream started (milliseconds since the epoch), if the platform tells. */
  since: z.number().int().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
});
const OfflineFields = z.object({});
const FollowFields = z.object({ user: StreamUser });
const SubscriptionFields = z.object({
  user: StreamUser,
  tier: Tier,
  /** Total months, when the platform tells (resubscriptions). */
  months: z.number().int().min(1).optional(),
  message: z.string().optional(),
});
const GiftSubscriptionFields = z.object({
  /** Missing for anonymous gifts. */
  gifter: StreamUser.optional(),
  count: z.number().int().min(1),
  tier: Tier,
});
const RaidFields = z.object({ from: StreamUser, viewers: z.number().int().min(0) });
const SupportFields = z.object({
  /** Missing for anonymous support. */
  user: StreamUser.optional(),
  amount: z.number().positive(),
  /** An ISO code (`EUR`) or a platform currency (`bits`). */
  currency: z.string().min(1),
  message: z.string().optional(),
});

const withSource = { source: Source };
const Online = OnlineFields.extend(withSource);
const Offline = OfflineFields.extend(withSource);
const Follow = FollowFields.extend(withSource);
const Subscription = SubscriptionFields.extend(withSource);
const GiftSubscription = GiftSubscriptionFields.extend(withSource);
const Raid = RaidFields.extend(withSource);
const Support = SupportFields.extend(withSource);

/** One event, by `type`, as it is buffered (with its source). */
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

/** What a platform pushes: one event, by `type`; stream adds `source` from the provider's key. */
export const InboundStreamEvent = z.discriminatedUnion('type', [
  OnlineFields.extend({ type: z.literal('online') }),
  OfflineFields.extend({ type: z.literal('offline') }),
  FollowFields.extend({ type: z.literal('follow') }),
  SubscriptionFields.extend({ type: z.literal('subscription') }),
  GiftSubscriptionFields.extend({ type: z.literal('giftSubscription') }),
  RaidFields.extend({ type: z.literal('raid') }),
  SupportFields.extend({ type: z.literal('support') }),
]);
export type InboundStreamEvent = z.input<typeof InboundStreamEvent>;

/** One entry of `stream.recent`. */
export const Activity = z.object({
  id: z.string(),
  /** Milliseconds since the epoch, when the event arrived. */
  timestamp: z.number().int(),
  event: StreamEvent,
});
export type Activity = z.output<typeof Activity>;

/** What a platform registers its connection with (the `info` of `stream.platform`). */
export const StreamConnectionInfo = z.object({
  channel: z.string().min(1),
  displayName: z.string().min(1),
  /** Whether the stream is live right now, so no `online` push is needed to say so. */
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
  version: '2.0.0',

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
  },

  providers: {
    /**
     * One per connection, keyed by its id (`twitch:roman`). No methods yet: outbound stream
     * operations go here.
     */
    platform: {
      key: ConnectionId,
      info: StreamConnectionInfo,
      inbound: { event: InboundStreamEvent },
    },
  },

  widgets: {
    activity: {},
  },
});
