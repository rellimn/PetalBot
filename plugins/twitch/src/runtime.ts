/**
 * One running Twitch connection: a client for the current credentials, its EventSub listener and
 * the domain providers, for one broadcaster (and, with a bot, its chat). The plugin builds a new
 * runtime whenever the credentials or accounts change and disposes the old one first.
 *
 * Stream (broadcaster only): `stream.platform` keyed `twitch:<login>`, events pushed as they
 * arrive, the live status in the info (spec §24.10: `update` on every transition).
 *
 * Chat (with a bot): `chat.platform` under the same key, sending through a rate limiter sized by
 * the bot's role (moderator or VIP: 100 per 30 s; otherwise 20 per 30 s, 1.5 s apart), which
 * follows the channel's moderator and VIP events.
 */
import { createRateLimiter, sourceOf, type PluginContext } from '@petalbot/sdk';
import type { chatContract } from '@petalbot-plugin/chat/contract';
import type { InboundStreamEvent, streamContract } from '@petalbot-plugin/stream/contract';
import type {
  AccountKind,
  Accounts,
  BotRole,
  SocketState,
  TwitchAccount,
  TwitchToken,
  twitchContract,
} from './contract.ts';
import { createChatMethods } from './chat-provider.ts';
import * as map from './mapping.ts';
import { errorText } from './redact.ts';
import { CHAT_MAX_QUEUE, CHAT_MAX_WAIT_MS, CHAT_WINDOW_MS, chatLimits } from './scopes.ts';
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
  /** Twitch revoked the account's authorization: its token is dead. */
  readonly onRevoked: (kind: AccountKind) => void;
}

/** Revocation statuses after which the account's token no longer works. */
const DEAD_TOKEN = new Set(['authorization_revoked', 'user_removed']);

export async function startRuntime(input: RuntimeInput): Promise<Runtime> {
  const { ctx, client, broadcaster, onChange, onRevoked } = input;
  const key = `twitch:${broadcaster.login}`;
  const status: RuntimeStatus = { eventSub: { broadcaster: 'off', bot: 'off' }, botRole: null };

  client.addUser(broadcaster.id, input.tokens.broadcaster);
  const bot = input.bot && input.tokens.bot ? input.bot : undefined;
  if (bot && input.tokens.bot) client.addUser(bot.id, input.tokens.bot);

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

  /** Set before the listener stops: Twurple still reports the sockets closing. */
  let disposed = false;
  /**
   * Runs a notification handler; a bad payload is logged, never thrown into Twurple. Nothing
   * runs once the runtime is disposed.
   */
  const guarded =
    <A extends unknown[]>(name: string, handler: (...args: A) => void) =>
    (...args: A): void => {
      if (disposed) return;
      try {
        handler(...args);
      } catch (error) {
        ctx.log.warn('Could not handle a Twitch notification', {
          notification: name,
          error: errorText(error),
        });
      }
    };
  const chat = bot ? await startChat(input, bot, key, status) : undefined;

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
    roleChanged: guarded('roleChanged', (event) => {
      if (chat?.roleChanged(event)) onChange();
    }),
    chatMessage: guarded('chatMessage', (event) => {
      if (chat && bot)
        chat.provided.push('message', map.toInboundMessage(event, bot.id, Date.now()));
    }),
    chatMessageDeleted: guarded('chatMessageDeleted', (event) => {
      chat?.provided.push('messageDeleted', { messageId: event.messageId });
    }),
    socket: guarded('socket', ({ kind, state }) => {
      status.eventSub[kind] = state;
      onChange();
    }),
    revoked: guarded('revoked', ({ kind, status: reason }) => {
      if (DEAD_TOKEN.has(reason)) onRevoked(kind);
      else ctx.log.warn('Twitch ended an EventSub subscription', { account: kind, reason });
    }),
  };
  const listener = client.listen(
    bot ? { broadcasterId: broadcaster.id, botId: bot.id } : { broadcasterId: broadcaster.id },
    handlers,
  );

  return {
    status,
    dispose() {
      disposed = true;
      listener.stop();
      chat?.dispose();
      stream.dispose();
      return Promise.resolve();
    },
  };
}

/** The chat side: the bot's role, the limiter and the `chat.platform` provider. */
async function startChat(
  input: RuntimeInput,
  bot: TwitchAccount,
  key: string,
  status: RuntimeStatus,
) {
  const { ctx, client, broadcaster } = input;
  let initial: BotRole = 'none';
  try {
    initial = await client.botRole(broadcaster.id, bot.id);
  } catch (error) {
    ctx.log.warn('Could not read the bot role; assuming a plain chatter', {
      error: errorText(error),
    });
  }
  const roles = { moderator: initial === 'moderator', vip: initial === 'vip' };
  const roleOf = (): BotRole => (roles.moderator ? 'moderator' : roles.vip ? 'vip' : 'none');
  status.botRole = roleOf();

  const limiter = createRateLimiter({
    ...chatLimits(status.botRole),
    windowMs: CHAT_WINDOW_MS,
    maxQueue: CHAT_MAX_QUEUE,
    maxWaitMs: CHAT_MAX_WAIT_MS,
  });
  const provided = ctx.provide('chat.platform', key, {
    info: { channel: broadcaster.login, displayName: broadcaster.displayName, isDefault: true },
    methods: createChatMethods({
      key,
      log: ctx.log,
      client,
      broadcasterId: broadcaster.id,
      botId: bot.id,
      limiter,
    }),
  });

  return {
    provided,
    /** Applies a role event; true when the bot's role changed. */
    roleChanged(event: { userId: string; role: 'moderator' | 'vip'; added: boolean }): boolean {
      if (event.userId !== bot.id) return false;
      const before = roleOf();
      roles[event.role] = event.added;
      const after = roleOf();
      if (after === before) return false;
      const limits = chatLimits(after);
      limiter.setLimit(limits.limit);
      limiter.setMinInterval(limits.minIntervalMs);
      status.botRole = after;
      return true;
    },
    dispose(): void {
      limiter.dispose();
      provided.dispose();
    },
  };
}
