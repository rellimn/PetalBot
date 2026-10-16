/**
 * One running Twitch connection: a client for the current credentials, its EventSub listener and
 * the domain providers, for one broadcaster (and, with a bot, its chat). The plugin builds a new
 * runtime whenever the credentials or accounts change and disposes the old one first.
 *
 * Stream (broadcaster only): `stream.platform` keyed `twitch:<login>`, events pushed as they
 * arrive, the live status in the info (spec §24.10: `update` on every transition).
 */
import { sourceOf, type PluginContext } from '@petalbot/sdk';
import type { chatContract } from '@petalbot-plugin/chat/contract';
import type { InboundStreamEvent, streamContract } from '@petalbot-plugin/stream/contract';
import type {
  Accounts,
  BotRole,
  SocketState,
  TwitchAccount,
  TwitchToken,
  twitchContract,
} from './contract.ts';
import * as map from './mapping.ts';
import type { TwitchClient, TwitchEventHandlers } from './twitch-client.ts';

export type TwitchContext = PluginContext<
  typeof twitchContract,
  readonly [typeof chatContract, typeof streamContract],
  [],
  { readonly accounts: typeof Accounts }
>;

export interface RuntimeStatus {
  readonly eventSub: { broadcaster: SocketState; bot: SocketState };
  /** Null while chat isn't running. */
  botRole: BotRole | null;
}

export interface Runtime {
  readonly status: RuntimeStatus;
  dispose(): Promise<void>;
}

export interface RuntimeInput {
  readonly ctx: TwitchContext;
  readonly client: TwitchClient;
  readonly broadcaster: TwitchAccount;
  readonly bot?: TwitchAccount | undefined;
  readonly tokens: { readonly broadcaster: TwitchToken; readonly bot?: TwitchToken | undefined };
  /** Called after anything in `status` changed. */
  readonly onChange: () => void;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function startRuntime(input: RuntimeInput): Promise<Runtime> {
  const { ctx, client, broadcaster, onChange } = input;
  const key = `twitch:${broadcaster.login}`;
  const status: RuntimeStatus = { eventSub: { broadcaster: 'off', bot: 'off' }, botRole: null };

  client.addUser(broadcaster.id, input.tokens.broadcaster);

  // Helix failures here must not keep the stream side down: start offline and let
  // stream.online correct it.
  let since: number | undefined;
  try {
    since = (await client.getStream(broadcaster.id))?.since;
  } catch (error) {
    ctx.log.warn('Could not read the Twitch stream status', { error: errorText(error) });
  }
  const channel = { channel: broadcaster.login, displayName: broadcaster.displayName };
  const stream = ctx.provide('stream.platform', key, {
    info: since === undefined ? { ...channel, live: false } : { ...channel, live: true, since },
  });

  /** Runs a notification handler; a bad payload is logged, never thrown into Twurple. */
  const guarded =
    <A extends unknown[]>(name: string, handler: (...args: A) => void) =>
    (...args: A): void => {
      try {
        handler(...args);
      } catch (error) {
        ctx.log.warn('Could not handle a Twitch notification', {
          notification: name,
          error: errorText(error),
        });
      }
    };
  const push = (event: InboundStreamEvent | null): void => {
    if (event) stream.push('event', event);
  };

  const handlers: TwitchEventHandlers = {
    streamOnline: guarded('streamOnline', (event) => {
      push(map.online(event));
      stream.update({ ...channel, live: true, since: event.since });
    }),
    streamOffline: guarded('streamOffline', () => {
      push({ type: 'offline' });
      stream.update({ ...channel, live: false });
    }),
    follow: guarded('follow', (event) => {
      push(map.follow(event));
    }),
    subscribe: guarded('subscribe', (event) => {
      push(map.subscription(event));
    }),
    subscriptionMessage: guarded('subscriptionMessage', (event) => {
      push(map.subscriptionMessage(event));
    }),
    subscriptionGift: guarded('subscriptionGift', (event) => {
      push(map.gift(event));
    }),
    raid: guarded('raid', (event) => {
      push(map.raid(event));
    }),
    cheer: guarded('cheer', (event) => {
      push(map.support(event));
      ctx.emit('twitch.cheer', {
        source: sourceOf(key),
        ...(event.user ? { user: event.user } : {}),
        bits: event.bits,
        message: event.message,
      });
    }),
    roleChanged: () => undefined,
    chatMessage: () => undefined,
    chatMessageDeleted: () => undefined,
    socket: guarded('socket', ({ kind, state }) => {
      status.eventSub[kind] = state;
      onChange();
    }),
  };
  const listener = client.listen({ broadcasterId: broadcaster.id }, handlers);

  return {
    status,
    dispose() {
      listener.stop();
      stream.dispose();
      return Promise.resolve();
    },
  };
}
