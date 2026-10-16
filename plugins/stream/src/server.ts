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
    let recent: Activity[] = [];

    const fromInfo = (info: { live: boolean; since?: number | undefined }): ConnectionStatus =>
      info.live && info.since !== undefined
        ? { live: true, since: info.since }
        : { live: info.live };

    // The info is the only source of the live status: it survives a restart of stream and
    // can't be overtaken by queued pushes. Platforms update it on every transition.
    providers.onChange(() => {
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
      recent = [{ id: randomUUID(), timestamp: now, event }, ...recent].slice(0, RECENT_LIMIT);
      announce(event);
    });

    return {
      rpc: {
        recent: () => recent,
        status: () =>
          Object.fromEntries(providers.list().map(({ key, info }) => [key, fromInfo(info)])),
      },
    };
  },
});
