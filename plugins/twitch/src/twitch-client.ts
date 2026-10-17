/**
 * The only module that imports Twurple. Everything else talks to Twitch through `TwitchClient`,
 * plain data in and out, so it can be tested against a fake (test/fake-client.ts).
 *
 * One client per set of app credentials: a `RefreshingAuthProvider` holding the accounts' tokens
 * (and fetching the app token from the client secret), one `ApiClient`, and at most one EventSub
 * listener, which opens one WebSocket per account.
 *
 * Not covered by `pnpm check`: the manual Twitch checklist in the M5c plan tests this file.
 */
import { ApiClient, ChatMessageDroppedError } from '@twurple/api';
import { RefreshingAuthProvider, exchangeCode, getTokenInfo, revokeToken } from '@twurple/auth';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import type { Logger } from '@petalbot/sdk';
import type { AccountKind, BotRole, SocketState, TwitchAccount, TwitchToken } from './contract.ts';
import { errorText, redact } from './redact.ts';

/** A Helix request Twitch answered with an error status. */
export class TwitchRequestError extends Error {
  /** The HTTP status. */
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TwitchRequestError';
    this.status = status;
  }
}

/** Twitch refused the app's client ID or secret (e.g. the secret was regenerated). */
export class AppCredentialsError extends Error {
  constructor(options?: ErrorOptions) {
    super('Twitch rejected the client ID or secret', options);
    this.name = 'AppCredentialsError';
  }
}

export interface TwitchClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Receives Twurple's warnings and errors. */
  readonly log: Logger;
  onTokenRefresh(userId: string, token: TwitchToken): void;
  /**
   * `invalid`: Twitch refused the refresh token (reconnect needed); `app`: it refused the client
   * ID or secret; `transient`: try later.
   */
  onRefreshFailure(userId: string, kind: RefreshFailure): void;
  /** Twitch refused the client ID or secret when asked for the app token. */
  onAppRejected(): void;
}

export type RefreshFailure = 'invalid' | 'app' | 'transient';

export type TwitchClientFactory = (options: TwitchClientOptions) => TwitchClient;

export type SendOutcome =
  | { readonly sent: true; readonly messageId: string }
  | { readonly sent: false; readonly code: string; readonly message: string };

export interface TwitchChatMessage {
  readonly messageId: string;
  readonly user: TwitchAccount;
  readonly text: string;
  /** EventSub badge set ids, e.g. 'broadcaster', 'moderator', 'vip', 'subscriber', 'founder'. */
  readonly badges: readonly string[];
  readonly reply?: {
    readonly id: string;
    readonly login: string;
    readonly displayName: string;
    readonly text: string;
  };
}

export interface TwitchEventHandlers {
  streamOnline(event: { since: number }): void;
  streamOffline(): void;
  follow(event: { user: TwitchAccount }): void;
  subscribe(event: { user: TwitchAccount; tier: string; isGift: boolean }): void;
  subscriptionMessage(event: {
    user: TwitchAccount;
    tier: string;
    months: number;
    message: string;
  }): void;
  subscriptionGift(event: { gifter?: TwitchAccount; count: number; tier: string }): void;
  raid(event: { from: TwitchAccount; viewers: number }): void;
  cheer(event: { user?: TwitchAccount; bits: number; message: string }): void;
  roleChanged(event: { userId: string; role: 'moderator' | 'vip'; added: boolean }): void;
  chatMessage(event: TwitchChatMessage): void;
  chatMessageDeleted(event: { messageId: string }): void;
  socket(event: { kind: AccountKind; state: SocketState }): void;
  /** Twitch ended a subscription, e.g. `authorization_revoked` at twitch.tv/settings/connections. */
  revoked(event: { kind: AccountKind; status: string }): void;
}

export interface TwitchListener {
  stop(): void;
}

export interface TwitchClient {
  exchangeCode(code: string, redirectUri: string): Promise<TwitchToken>;
  /** Who the token belongs to. */
  tokenUser(token: TwitchToken): Promise<TwitchAccount>;
  revoke(token: TwitchToken): Promise<void>;
  /** Fetches the app token; throws `AppCredentialsError` when Twitch refuses the credentials. */
  verifyApp(): Promise<void>;
  addUser(userId: string, token: TwitchToken): void;
  /** The running stream's start, or null when offline. */
  getStream(broadcasterId: string): Promise<{ readonly since: number } | null>;
  botRole(broadcasterId: string, botId: string): Promise<BotRole>;
  /** Sends as the bot with the app token (Twitch's "Chat Bot" badge). */
  sendMessage(input: {
    broadcasterId: string;
    botId: string;
    text: string;
    replyTo?: string | undefined;
  }): Promise<SendOutcome>;
  deleteMessage(input: { broadcasterId: string; botId: string; messageId: string }): Promise<void>;
  timeoutUser(input: {
    broadcasterId: string;
    botId: string;
    userId: string;
    seconds: number;
    reason?: string | undefined;
  }): Promise<void>;
  /** Subscribes the broadcaster's events, and the chat when `botId` is set, then connects. */
  listen(
    users: { broadcasterId: string; botId?: string | undefined },
    handlers: TwitchEventHandlers,
  ): TwitchListener;
}

/** Twurple's `HttpStatusCodeError` (its package isn't a direct dependency, so duck-typed). */
function statusOf(error: unknown): { status: number; body: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const { statusCode, body } = error as Error & { statusCode?: unknown; body?: unknown };
  return typeof statusCode === 'number'
    ? { status: statusCode, body: typeof body === 'string' ? body : error.message }
    : undefined;
}

/** Twitch's token endpoint names the client: `invalid client` (ID), `invalid client secret`. */
const INVALID_CLIENT = /invalid client/i;

/** Twitch answers a refused refresh token with 400 (or 401); anything else may pass. */
export function refreshFailureKind(error: unknown): RefreshFailure {
  const failed = statusOf(error);
  if (!failed) return 'transient';
  if (INVALID_CLIENT.test(failed.body)) return 'app';
  return failed.status === 400 || failed.status === 401 ? 'invalid' : 'transient';
}

/** Whether an app token request failed because Twitch refused the client ID or secret. */
export function appCredentialsRefused(error: unknown): boolean {
  const failed = statusOf(error);
  return failed !== undefined && [400, 401, 403].includes(failed.status);
}

/** Twurple throws `ChatMessageDroppedError` when Twitch answers `is_sent: false`. */
export function droppedOutcome(error: unknown): SendOutcome | undefined {
  if (!(error instanceof ChatMessageDroppedError)) return undefined;
  const reason = /dropped: (.*)$/s.exec(error.message)?.[1] ?? error.message;
  return { sent: false, code: error.code ?? 'unknown', message: reason };
}

/** Runs a Helix request; error statuses become `TwitchRequestError`. */
async function helix<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const failed = statusOf(error);
    if (failed) throw new TwitchRequestError(failed.status, redact(failed.body), { cause: error });
    throw error;
  }
}

const tokenOf = (token: {
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  expiresIn: number | null;
  obtainmentTimestamp: number;
}): TwitchToken => ({
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  scope: [...token.scope],
  expiresIn: token.expiresIn,
  obtainmentTimestamp: token.obtainmentTimestamp,
});

const account = (id: string, login: string, displayName: string): TwitchAccount => ({
  id,
  login,
  displayName,
});

export const createTwurpleClient: TwitchClientFactory = (options) => {
  const { clientId, clientSecret, log } = options;
  // Twurple's log levels: 0 critical, 1 error, 2 warning, 3 info, 4 debug, 7 trace.
  const logger = {
    minLevel: 'warning',
    custom: (level: number, message: string) => {
      if (level <= 1) log.error(`Twurple: ${redact(message)}`);
      else log.warn(`Twurple: ${redact(message)}`);
    },
  };
  const auth = new RefreshingAuthProvider({ clientId, clientSecret });
  auth.onRefresh((userId, token) => {
    options.onTokenRefresh(userId, tokenOf(token));
  });
  auth.onRefreshFailure((userId, error) => {
    options.onRefreshFailure(userId, refreshFailureKind(error));
  });
  // Every app token request (the first one and the retry after a 401) goes through here.
  const getAppAccessToken = auth.getAppAccessToken.bind(auth);
  auth.getAppAccessToken = async (forceNew) => {
    try {
      return await getAppAccessToken(forceNew);
    } catch (error) {
      if (!appCredentialsRefused(error)) throw error;
      options.onAppRejected();
      throw new AppCredentialsError({ cause: error });
    }
  };
  const api = new ApiClient({ authProvider: auth, logger });

  return {
    async exchangeCode(code, redirectUri) {
      return tokenOf(await helix(() => exchangeCode(clientId, clientSecret, code, redirectUri)));
    },
    async tokenUser(token) {
      const info = await helix(() => getTokenInfo(token.accessToken, clientId));
      if (info.userId === null) throw new Error('The token belongs to no user');
      const userId = info.userId;
      // Looked up with the app token: the account isn't added to the auth provider yet.
      const user = await helix(() => api.users.getUserById(userId));
      if (!user) throw new Error(`Twitch user ${userId} not found`);
      return account(user.id, user.name, user.displayName);
    },
    async verifyApp() {
      await auth.getAppAccessToken();
    },
    async revoke(token) {
      await helix(() => revokeToken(clientId, token.accessToken));
    },
    addUser(userId, token) {
      if (auth.hasUser(userId)) auth.removeUser(userId);
      auth.addUser(userId, token);
    },
    async getStream(broadcasterId) {
      const stream = await helix(() => api.streams.getStreamByUserId(broadcasterId));
      return stream ? { since: stream.startDate.getTime() } : null;
    },
    async botRole(broadcasterId, botId) {
      if (await helix(() => api.moderation.checkUserMod(broadcasterId, botId))) return 'moderator';
      return (await helix(() => api.channels.checkVipForUser(broadcasterId, botId)))
        ? 'vip'
        : 'none';
    },
    async sendMessage({ broadcasterId, botId, text, replyTo }) {
      try {
        const sent = await helix(() =>
          api.chat.sendChatMessageAsApp(
            botId,
            broadcasterId,
            text,
            replyTo === undefined ? {} : { replyParentMessageId: replyTo },
          ),
        );
        return { sent: true, messageId: sent.id };
      } catch (error) {
        const dropped = droppedOutcome(error);
        if (dropped) return dropped;
        throw error;
      }
    },
    async deleteMessage({ broadcasterId, botId, messageId }) {
      await helix(() =>
        api.asUser(botId, (bot) => bot.moderation.deleteChatMessages(broadcasterId, messageId)),
      );
    },
    async timeoutUser({ broadcasterId, botId, userId, seconds, reason }) {
      await helix(() =>
        api.asUser(botId, (bot) =>
          bot.moderation.banUser(broadcasterId, {
            user: userId,
            duration: seconds,
            reason: reason ?? '',
          }),
        ),
      );
    },
    listen({ broadcasterId, botId }, handlers) {
      const listener = new EventSubWsListener({ apiClient: api, logger });
      const b = broadcasterId;
      const kindOf = (userId: string): AccountKind => (userId === b ? 'broadcaster' : 'bot');
      listener.onUserSocketConnect((userId) => {
        handlers.socket({ kind: kindOf(userId), state: 'connecting' });
      });
      listener.onUserSocketReady((userId) => {
        handlers.socket({ kind: kindOf(userId), state: 'connected' });
      });
      listener.onUserSocketDisconnect((userId, error) => {
        if (error)
          log.warn('Twitch EventSub disconnected', {
            account: kindOf(userId),
            error: errorText(error),
          });
        handlers.socket({ kind: kindOf(userId), state: 'disconnected' });
      });
      /** Ids of the subscriptions made with the bot's token; all others use the broadcaster's. */
      const botSubscriptions = new Set<string>();
      listener.onRevoke((subscription, status) => {
        handlers.revoked({
          kind: botSubscriptions.has(subscription.id) ? 'bot' : 'broadcaster',
          status,
        });
      });
      listener.onSubscriptionCreateFailure((subscription, error) => {
        log.warn('Twitch EventSub subscription failed', {
          subscription: subscription.id,
          error: errorText(error),
        });
      });

      listener.onStreamOnline(b, (e) => {
        handlers.streamOnline({ since: e.startDate.getTime() });
      });
      listener.onStreamOffline(b, () => {
        handlers.streamOffline();
      });
      listener.onChannelFollow(b, b, (e) => {
        handlers.follow({ user: account(e.userId, e.userName, e.userDisplayName) });
      });
      listener.onChannelSubscription(b, (e) => {
        handlers.subscribe({
          user: account(e.userId, e.userName, e.userDisplayName),
          tier: e.tier,
          isGift: e.isGift,
        });
      });
      listener.onChannelSubscriptionMessage(b, (e) => {
        handlers.subscriptionMessage({
          user: account(e.userId, e.userName, e.userDisplayName),
          tier: e.tier,
          months: e.cumulativeMonths,
          message: e.messageText,
        });
      });
      listener.onChannelSubscriptionGift(b, (e) => {
        const gifter =
          e.isAnonymous || e.gifterId === null
            ? undefined
            : account(e.gifterId, e.gifterName ?? '', e.gifterDisplayName ?? '');
        handlers.subscriptionGift({
          ...(gifter ? { gifter } : {}),
          count: e.amount,
          tier: e.tier,
        });
      });
      listener.onChannelRaidTo(b, (e) => {
        handlers.raid({
          from: account(
            e.raidingBroadcasterId,
            e.raidingBroadcasterName,
            e.raidingBroadcasterDisplayName,
          ),
          viewers: e.viewers,
        });
      });
      listener.onChannelCheer(b, (e) => {
        const user =
          e.isAnonymous || e.userId === null
            ? undefined
            : account(e.userId, e.userName ?? '', e.userDisplayName ?? '');
        handlers.cheer({ ...(user ? { user } : {}), bits: e.bits, message: e.message });
      });
      listener.onChannelModeratorAdd(b, (e) => {
        handlers.roleChanged({ userId: e.userId, role: 'moderator', added: true });
      });
      listener.onChannelModeratorRemove(b, (e) => {
        handlers.roleChanged({ userId: e.userId, role: 'moderator', added: false });
      });
      listener.onChannelVipAdd(b, (e) => {
        handlers.roleChanged({ userId: e.userId, role: 'vip', added: true });
      });
      listener.onChannelVipRemove(b, (e) => {
        handlers.roleChanged({ userId: e.userId, role: 'vip', added: false });
      });

      if (botId !== undefined) {
        const message = listener.onChannelChatMessage(b, botId, (e) => {
          // Shared chat: messages from the other channels of the session are not this chat's.
          if (e.sourceBroadcasterId !== null && e.sourceBroadcasterId !== b) return;
          const reply =
            e.parentMessageId === null
              ? undefined
              : {
                  id: e.parentMessageId,
                  login: e.parentMessageUserName ?? '',
                  displayName: e.parentMessageUserDisplayName ?? '',
                  text: e.parentMessageText ?? '',
                };
          handlers.chatMessage({
            messageId: e.messageId,
            user: account(e.chatterId, e.chatterName, e.chatterDisplayName),
            text: e.messageText,
            badges: Object.keys(e.badges),
            ...(reply ? { reply } : {}),
          });
        });
        const deleted = listener.onChannelChatMessageDelete(b, botId, (e) => {
          handlers.chatMessageDeleted({ messageId: e.messageId });
        });
        botSubscriptions.add(message.id).add(deleted.id);
      }

      listener.start();
      return {
        stop() {
          listener.stop();
        },
      };
    },
  };
};
