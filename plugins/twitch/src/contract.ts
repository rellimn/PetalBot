/**
 * The twitch platform plugin: connects a broadcaster and a bot account and serves the `chat` and
 * `stream` domains for that channel.
 *
 * Consumers use `chat.*` and `stream.*`; this contract holds only what the domains can't express:
 * the connection state for the Twitch page, cheers with their bits, and disconnecting accounts.
 *
 * Runs everywhere (server, panel), so it imports only zod and @petalbot/sdk.
 * Guide: docs/plugin-guide.md#12-platforms-and-providers; setup: plugins/twitch/README.md.
 */
import { z } from 'zod';
import { PlatformUser, Result, Source, defineContract } from '@petalbot/sdk';

export const AccountKind = z.enum(['broadcaster', 'bot']);
export type AccountKind = z.output<typeof AccountKind>;

export const TwitchAccount = PlatformUser;
export type TwitchAccount = z.output<typeof TwitchAccount>;

/** Twurple's `AccessToken`, stored per Twitch user id. */
export const TwitchToken = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  scope: z.array(z.string()),
  expiresIn: z.number().int().nullable(),
  obtainmentTimestamp: z.number().int(),
});
export type TwitchToken = z.output<typeof TwitchToken>;

/** The connected accounts (KV `accounts`). */
export const Accounts = z.object({
  broadcaster: TwitchAccount.optional(),
  bot: TwitchAccount.optional(),
});
export type Accounts = z.output<typeof Accounts>;

export const AccountStatus = TwitchAccount.extend({
  /** `reconnect-required` after Twitch refused to refresh the account's token. */
  state: z.enum(['connected', 'reconnect-required']),
});
export type AccountStatus = z.output<typeof AccountStatus>;

/** One EventSub WebSocket, per account. */
export const SocketState = z.enum(['off', 'connecting', 'connected', 'disconnected']);
export type SocketState = z.output<typeof SocketState>;

/** The bot's role in the channel: moderators and VIPs may send more. */
export const BotRole = z.enum(['moderator', 'vip', 'none']);
export type BotRole = z.output<typeof BotRole>;

export const TwitchStatus = z.object({
  /** Client ID and client secret are set. */
  configured: z.boolean(),
  /** Twitch refused the client ID or secret (e.g. the secret was regenerated at Twitch). */
  credentialsRejected: z.boolean(),
  /** The OAuth redirect URL to register in the Twitch application. */
  redirectUrl: z.string(),
  broadcaster: AccountStatus.nullable(),
  bot: AccountStatus.nullable(),
  /** Null while chat isn't running. */
  botRole: BotRole.nullable(),
  eventSub: z.object({ broadcaster: SocketState, bot: SocketState }),
});
export type TwitchStatus = z.output<typeof TwitchStatus>;

export const twitchContract = defineContract({
  id: 'twitch',
  version: '1.1.1',

  settings: z.object({
    clientId: z
      .string()
      .trim()
      .default('')
      .describe('From dev.twitch.tv > Your Console > Applications'),
  }),

  secrets: {
    clientSecret: {
      userSettable: true,
      label: 'Client secret',
      description: 'From dev.twitch.tv > Your Console > Applications',
    },
    tokens: { schema: TwitchToken, keyed: true },
  },

  events: {
    /** An account, the bot's role or an EventSub connection changed. */
    connectionChanged: { schema: z.object({}), expose: ['panel'] },
    /** Bits were cheered (also arrives as `stream.support` with currency `bits`). */
    cheer: {
      schema: z.object({
        source: Source,
        /** Missing for anonymous cheers. */
        user: PlatformUser.optional(),
        bits: z.number().int().min(1),
        message: z.string(),
      }),
      expose: ['panel'],
      flow: { label: 'Twitch cheer', description: 'Someone cheered bits' },
    },
  },

  rpc: {
    status: { kind: 'query', output: TwitchStatus, expose: { panel: 'mod' } },
    /** Revokes the account's token at Twitch (best effort) and forgets the account. */
    disconnect: {
      input: z.object({ account: AccountKind }),
      output: Result(z.object({}), []),
      expose: { panel: 'owner' },
    },
  },
});
