/**
 * The stream domain's server side: connections, pushed events, the activity buffer and live status.
 *
 * A connection is a live `stream.platform` provider. Its pushes become the matching events,
 * and stream keeps the last ones for the Activity widget.
 *
 * Guide: docs/plugin-guide.md#12-platforms-and-providers.
 */
import { randomUUID } from 'node:crypto';
import { definePlugin, sourceOf } from '@petalbot/sdk';
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
    /** Live status per connection: from the info, then from online/offline pushes. */
    const status = new Map<string, ConnectionStatus>();
    let recent: Activity[] = [];

    const fromInfo = (info: { live: boolean; since?: number | undefined }): ConnectionStatus =>
      info.live && info.since !== undefined
        ? { live: true, since: info.since }
        : { live: info.live };

    // Connections that are already there when stream (re)starts keep their status.
    for (const provider of providers.list()) status.set(provider.key, fromInfo(provider.info));

    providers.onChange(({ key, change }) => {
      const provider = providers.get(key);
      if (change === 'removed' || !provider) status.delete(key);
      else status.set(key, fromInfo(provider.info));
      ctx.emit('stream.connectionsChanged', {});
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

    providers.on('event', (pushed, provider) => {
      const event: StreamEvent = { ...pushed, source: sourceOf(provider.key) };
      const now = Date.now();
      const current = status.get(provider.key);
      if (event.type === 'online') {
        // A repeated online (a redelivery) keeps the start time it already has.
        const since = event.since ?? (current?.live ? (current.since ?? now) : now);
        status.set(provider.key, { live: true, since });
      }
      if (event.type === 'offline') status.set(provider.key, { live: false });
      recent = [{ id: randomUUID(), timestamp: now, event }, ...recent].slice(0, RECENT_LIMIT);
      announce(event);
    });

    return {
      rpc: {
        recent: () => recent,
        status: () =>
          Object.fromEntries(
            providers.list().flatMap(({ key }) => {
              const entry = status.get(key);
              return entry ? [[key, entry]] : [];
            }),
          ),
      },
    };
  },
});
