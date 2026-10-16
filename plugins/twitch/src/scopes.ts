/**
 * What Twitch asks each account for, and the limits the plugin works within.
 *
 * Scopes (spec §23.6, §23.9): the broadcaster's token reads stream events and grants `channel:bot`
 * so the app may send in the channel; the bot's token reads chat and moderates. Messages are sent
 * with the app token, so they carry Twitch's "Chat Bot" badge.
 */
import type { AccountKind, BotRole } from './contract.ts';

export const SCOPES: Readonly<Record<AccountKind, readonly string[]>> = {
  broadcaster: [
    'channel:bot',
    'moderator:read:followers',
    'channel:read:subscriptions',
    'bits:read',
    'moderation:read',
    'channel:read:vips',
  ],
  bot: [
    'user:bot',
    'user:read:chat',
    'user:write:chat',
    'moderator:manage:chat_messages',
    'moderator:manage:banned_users',
  ],
};

/** How long an OAuth `state` stays valid. */
export const STATE_TTL_MS = 600_000;

export const CHAT_WINDOW_MS = 30_000;
export const CHAT_MAX_QUEUE = 20;
/** Below `chat.platform.send`'s 12 s timeout. */
export const CHAT_MAX_WAIT_MS = 10_000;
/** After Twitch dropped a message for its rate limit. */
export const RATE_LIMIT_PAUSE_MS = 30_000;

/**
 * Twitch's chat limits: 100 messages per 30 s for moderators and VIPs; otherwise 20 per 30 s and
 * at most one per second.
 */
export function chatLimits(role: BotRole): { limit: number; minIntervalMs: number } {
  return role === 'none' ? { limit: 20, minIntervalMs: 1000 } : { limit: 100, minIntervalMs: 0 };
}
