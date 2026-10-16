/**
 * The stream domain's server side: connections, ingest, the activity buffer and live status.
 *
 * The providing platform plugin calls `stream.ingest`; stream emits the matching event and
 * keeps the last ones for the Activity widget.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { randomUUID } from 'node:crypto';
import { AccessError, ValidationError, definePlugin } from '@petalbot/sdk';
import {
  streamContract,
  type Activity,
  type ConnectionStatus,
  type StreamEvent,
} from './contract.ts';
import { RECENT_LIMIT } from './limits.ts';

export default definePlugin(streamContract, {
  setup(ctx) {
    const providers = ctx.providers('stream.platform');
    /** Registered connections by id: the plugin that provides each, and its live status. */
    const registered = new Map<
      string,
      { readonly platform: string; readonly by: string; status: ConnectionStatus }
    >();
    let recent: Activity[] = [];

    // A provider that goes away (disposed, or its plugin stopped) takes its connection along.
    providers.onChange(({ key, pluginId, change }) => {
      if (change === 'removed' && registered.get(key)?.by === pluginId) {
        registered.delete(key);
        ctx.emit('stream.connectionsChanged', {});
      }
    });

    /** Emits the event under its own name; the event's schema strips `type`. */
    const announce = (event: StreamEvent): void => {
      switch (event.type) {
        case 'online':
          ctx.emit('stream.online', event);
          return;
        case 'offline':
          ctx.emit('stream.offline', event);
          return;
        case 'follow':
          ctx.emit('stream.follow', event);
          return;
        case 'subscription':
          ctx.emit('stream.subscription', event);
          return;
        case 'giftSubscription':
          ctx.emit('stream.giftSubscription', event);
          return;
        case 'raid':
          ctx.emit('stream.raid', event);
          return;
        case 'support':
          ctx.emit('stream.support', event);
          return;
      }
    };

    return {
      rpc: {
        recent: () => recent,

        status: () => Object.fromEntries([...registered].map(([id, { status }]) => [id, status])),

        registerConnection: ({ id, platform, live, since }, { caller }) => {
          if (!id.startsWith(`${platform}:`)) {
            throw new ValidationError('stream connection', [
              {
                code: 'custom',
                path: ['id'],
                message: `A ${platform} connection id starts with "${platform}:"`,
                input: id,
              },
            ]);
          }
          if (providers.get(id)?.pluginId !== caller) {
            throw new AccessError(
              `Plugin "${caller}" does not provide "stream.platform" for "${id}" (call ctx.provide first)`,
            );
          }
          const status = live ? { live, ...(since === undefined ? {} : { since }) } : { live };
          registered.set(id, { platform, by: caller, status });
          ctx.emit('stream.connectionsChanged', {});
          return {};
        },

        ingest: (event, { caller }) => {
          const { connection, platform } = event.source;
          const entry = registered.get(connection);
          if (entry?.by !== caller || entry.platform !== platform) {
            throw new AccessError(
              `Plugin "${caller}" has not registered the stream connection "${connection}"`,
            );
          }
          const now = Date.now();
          if (event.type === 'online') {
            // A repeated online (a redelivery) keeps the start time it already has.
            const since = event.since ?? (entry.status.live ? (entry.status.since ?? now) : now);
            entry.status = { live: true, since };
          }
          if (event.type === 'offline') entry.status = { live: false };
          recent = [{ id: randomUUID(), timestamp: now, event }, ...recent].slice(0, RECENT_LIMIT);
          announce(event);
          return {};
        },
      },
    };
  },
});
