/**
 * EventSub notifications (as `TwitchClient` delivers them) -> what the twitch plugin pushes into
 * the `chat` and `stream` domains. Pure functions: the domains add `source` from the key.
 */
import type { InboundMessage } from '@petalbot-plugin/chat/contract';
import type { InboundStreamEvent } from '@petalbot-plugin/stream/contract';
import type { TwitchAccount } from './contract.ts';
import type { TwitchChatMessage } from './twitch-client.ts';

type EventOf<T extends InboundStreamEvent['type']> = Extract<InboundStreamEvent, { type: T }>;

/** Twitch's `1000`/`2000`/`3000` -> 1/2/3. Prime arrives as `1000`; anything unknown counts as 1. */
export function tierOf(tier: string): number {
  if (tier === '2000') return 2;
  if (tier === '3000') return 3;
  return 1;
}

/**
 * A chat message. `now` is the receipt time (Twurple doesn't expose the notification's). Twitch
 * starts a reply's text with `@<parent login>`; it is stripped, since `replyTo` says the same.
 */
export function toInboundMessage(
  event: TwitchChatMessage,
  botId: string,
  now: number,
): InboundMessage {
  const badges = new Set(event.badges);
  const mention = event.reply ? `@${event.reply.login} ` : undefined;
  const text =
    mention !== undefined && event.text.toLowerCase().startsWith(mention.toLowerCase())
      ? event.text.slice(mention.length)
      : event.text;
  return {
    id: event.messageId,
    user: {
      ...event.user,
      badges: {
        broadcaster: badges.has('broadcaster'),
        moderator: badges.has('moderator'),
        vip: badges.has('vip'),
        subscriber: badges.has('subscriber') || badges.has('founder'),
      },
    },
    text,
    ...(event.reply ? { replyTo: { ...event.reply } } : {}),
    timestamp: now,
    fromBot: event.user.id === botId,
  };
}

export const online = ({ since }: { since: number }): EventOf<'online'> => ({
  type: 'online',
  since,
});

export const follow = ({ user }: { user: TwitchAccount }): EventOf<'follow'> => ({
  type: 'follow',
  user,
});

/** Null for gifted subscriptions: `subscriptionGift` announces those once for the gifter. */
export const subscription = (event: {
  user: TwitchAccount;
  tier: string;
  isGift: boolean;
}): EventOf<'subscription'> | null =>
  event.isGift ? null : { type: 'subscription', user: event.user, tier: tierOf(event.tier) };

export const subscriptionMessage = (event: {
  user: TwitchAccount;
  tier: string;
  months: number;
  message: string;
}): EventOf<'subscription'> => ({
  type: 'subscription',
  user: event.user,
  tier: tierOf(event.tier),
  months: event.months,
  message: event.message,
});

export const gift = (event: {
  gifter?: TwitchAccount | undefined;
  count: number;
  tier: string;
}): EventOf<'giftSubscription'> => ({
  type: 'giftSubscription',
  ...(event.gifter ? { gifter: event.gifter } : {}),
  count: event.count,
  tier: tierOf(event.tier),
});

export const raid = (event: { from: TwitchAccount; viewers: number }): EventOf<'raid'> => ({
  type: 'raid',
  from: event.from,
  viewers: event.viewers,
});

/** A cheer is support in the platform currency `bits`. */
export const support = (event: {
  user?: TwitchAccount | undefined;
  bits: number;
  message: string;
}): EventOf<'support'> => ({
  type: 'support',
  ...(event.user ? { user: event.user } : {}),
  amount: event.bits,
  currency: 'bits',
  message: event.message,
});
