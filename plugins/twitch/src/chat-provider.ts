/**
 * The `chat.platform` methods for one Twitch channel: Helix calls as the bot, sends through the
 * connection's rate limiter, and Twitch's answers mapped to chat's failure definitions
 * (plugins/chat/README.md#failure-contract). Twitch's own wording only goes into `message`.
 */
import { fail, ok, rateLimitedFailure, type ProviderImpl, type RateLimiter } from '@petalbot/sdk';
import {
  messageNotFound,
  messageRejected,
  permissionDenied,
  providerError,
  userNotFound,
  type Capability,
  type chatContract,
} from '@petalbot-plugin/chat/contract';
import { RATE_LIMIT_PAUSE_MS } from './scopes.ts';
import { TwitchRequestError, type SendOutcome, type TwitchClient } from './twitch-client.ts';

type ChatPlatformSlot = (typeof chatContract)['providers']['platform'];

export interface ChatMethodsInput {
  readonly key: string;
  readonly client: TwitchClient;
  readonly broadcasterId: string;
  readonly botId: string;
  readonly limiter: RateLimiter;
}

/** Twitch's drop codes for its chat rate limit (unverified: see the M5c manual checklist). */
export const isRateLimitDrop = (code: string): boolean => /rate.?limit/i.test(code);

/** Request failures every method shares; anything that isn't a Twitch answer is rethrown. */
function classify(error: unknown, key: string, capability: Capability) {
  if (!(error instanceof TwitchRequestError)) throw error;
  if (error.status === 401 || error.status === 403) {
    return fail(permissionDenied, {}, error.message);
  }
  return fail(providerError, { connection: key, capability }, error.message);
}

export function createChatMethods(input: ChatMethodsInput): ProviderImpl<ChatPlatformSlot> {
  const { key, client, broadcasterId, botId, limiter } = input;

  /** Sends through the limiter; `rate-limited` means Twitch never saw the message. */
  const sendLimited = async (text: string, replyTo?: string) => {
    const scheduled = await limiter.schedule(() =>
      client.sendMessage({
        broadcasterId,
        botId,
        text,
        ...(replyTo === undefined ? {} : { replyTo }),
      }),
    );
    if (!scheduled.ok) return scheduled;
    const outcome: SendOutcome = scheduled.value;
    if (outcome.sent) return { ok: true as const, messageId: outcome.messageId };
    if (isRateLimitDrop(outcome.code)) {
      limiter.pause(RATE_LIMIT_PAUSE_MS);
      return fail(rateLimitedFailure, {}, `${outcome.code}: ${outcome.message}`);
    }
    return fail(messageRejected, {}, `${outcome.code}: ${outcome.message}`);
  };

  return {
    async send({ text }) {
      try {
        return await sendLimited(text);
      } catch (error) {
        return classify(error, key, 'send');
      }
    },
    async reply({ to, text }) {
      try {
        const sent = await sendLimited(text, to.id);
        return sent.ok ? ok({ messageId: sent.messageId, delivery: 'native' as const }) : sent;
      } catch (error) {
        if (
          error instanceof TwitchRequestError &&
          error.status === 400 &&
          error.message.includes('reply_parent_message_id')
        ) {
          return fail(messageNotFound, { messageId: to.id }, error.message);
        }
        return classify(error, key, 'reply');
      }
    },
    async delete({ messageId }) {
      try {
        await client.deleteMessage({ broadcasterId, botId, messageId });
        return ok();
      } catch (error) {
        if (error instanceof TwitchRequestError && error.status === 404) {
          return fail(messageNotFound, { messageId }, error.message);
        }
        return classify(error, key, 'delete');
      }
    },
    async timeout({ userId, seconds, reason }) {
      try {
        await client.timeoutUser({
          broadcasterId,
          botId,
          userId,
          seconds,
          ...(reason === undefined ? {} : { reason }),
        });
        return ok();
      } catch (error) {
        if (error instanceof TwitchRequestError && error.status === 404) {
          return fail(userNotFound, { userId }, error.message);
        }
        return classify(error, key, 'timeout');
      }
    },
  };
}
