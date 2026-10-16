/**
 * The stream panel client. `stream.recent` follows the events one by one (no round trip);
 * `stream.status` refetches when a stream starts or ends, or a connection comes or goes.
 */
import { createPluginClient } from '@petalbot/ui-sdk';
import { streamContract, type Activity, type StreamEvent } from './contract.ts';
import { RECENT_LIMIT } from './limits.ts';

/** The live copy of an entry: the event envelope's id and time stand in for the server's. */
const prepend = (
  list: Activity[],
  envelope: { readonly id: string; readonly timestamp: number },
  event: StreamEvent,
): Activity[] =>
  [{ id: envelope.id, timestamp: envelope.timestamp, event }, ...list].slice(0, RECENT_LIMIT);

export const api = createPluginClient(streamContract, {
  queries: {
    'stream.recent': {
      update: {
        'stream.online': (list, e) => prepend(list, e, { type: 'online', ...e.payload }),
        'stream.offline': (list, e) => prepend(list, e, { type: 'offline', ...e.payload }),
        'stream.follow': (list, e) => prepend(list, e, { type: 'follow', ...e.payload }),
        'stream.subscription': (list, e) =>
          prepend(list, e, { type: 'subscription', ...e.payload }),
        'stream.giftSubscription': (list, e) =>
          prepend(list, e, { type: 'giftSubscription', ...e.payload }),
        'stream.raid': (list, e) => prepend(list, e, { type: 'raid', ...e.payload }),
        'stream.support': (list, e) => prepend(list, e, { type: 'support', ...e.payload }),
      },
    },
    'stream.status': {
      refreshOn: ['stream.online', 'stream.offline', 'stream.connectionsChanged'],
    },
  },
});
