/**
 * The chat panel client. `chat.recent` follows the chat event by event (no round trip per
 * message); `chat.connections` refetches when a connection comes or goes.
 */
import { createPluginClient } from '@petalbot/ui-sdk';
import { chatContract } from './contract.ts';
import { RECENT_LIMIT } from './limits.ts';

export const api = createPluginClient(chatContract, {
  queries: {
    'chat.recent': {
      update: {
        // Skips a message the list already has (a fetch that raced the event, a redelivery).
        'chat.message': (list, event) =>
          list.some(
            (message) =>
              message.id === event.payload.id &&
              message.source.connection === event.payload.source.connection,
          )
            ? list
            : [...list, { ...event.payload, deleted: false }].slice(-RECENT_LIMIT),
        'chat.messageDeleted': (list, event) =>
          list.map((message) =>
            message.id === event.payload.messageId &&
            message.source.connection === event.payload.source.connection
              ? { ...message, deleted: true }
              : message,
          ),
      },
    },
    'chat.connections': { refreshOn: ['chat.connectionsChanged'] },
  },
  mutations: {
    // The sent message comes back as chat.message from the platform; nothing to refetch.
    'chat.send': { invalidates: [] },
    'chat.delete': { invalidates: [] },
    'chat.reply': { invalidates: [] },
  },
  // Codes not listed here get the generic text of their reason.
  failures: {
    'send-vetoed': () => 'Message blocked by a chat rule.',
    'connection-not-found': () =>
      'This chat connection is no longer available. Choose another connection.',
    'ambiguous-target': () => 'Choose a chat connection before sending.',
  },
});
