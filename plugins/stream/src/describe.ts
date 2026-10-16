/** One line of text per stream event, as the Activity widget shows it. */
import type { StreamEvent } from './contract.ts';

const tier = (n: number): string => `Tier ${String(n)}`;

export function describeEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'online': {
      const about = [event.title, event.category].filter((part) => part !== undefined);
      return about.length === 0 ? 'Stream started' : `Stream started: ${about.join(' - ')}`;
    }
    case 'offline':
      return 'Stream ended';
    case 'follow':
      return `${event.user.displayName} followed`;
    case 'subscription': {
      const months = event.months === undefined ? '' : `, ${String(event.months)} months`;
      return `${event.user.displayName} subscribed (${tier(event.tier)}${months})`;
    }
    case 'giftSubscription': {
      const subs = event.count === 1 ? 'sub' : 'subs';
      const who = event.gifter?.displayName ?? 'Anonymous';
      return `${who} gifted ${String(event.count)} ${tier(event.tier)} ${subs}`;
    }
    case 'raid':
      return `${event.from.displayName} raided with ${String(event.viewers)} viewers`;
    case 'support':
      return `${event.user?.displayName ?? 'Anonymous'} sent ${String(event.amount)} ${event.currency}`;
  }
}

/** The viewer's own words, when the event carries some. */
export function messageOf(event: StreamEvent): string | undefined {
  return event.type === 'subscription' || event.type === 'support' ? event.message : undefined;
}
