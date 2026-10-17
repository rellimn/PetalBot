# twitch

The Twitch platform plugin. It connects a **broadcaster** and a **bot** account and serves the
[`chat`](../chat/README.md) and [`stream`](../stream/README.md) domains for that channel:
consumers use `chat.*` and `stream.*` and never see Twitch. How the pieces fit:
[docs/plugin-guide.md, section 12](../../docs/plugin-guide.md#12-platforms-and-providers).

## Setup

1. Create an application at [dev.twitch.tv > Your Console > Applications](https://dev.twitch.tv/console/apps)
   (category "Chat Bot", client type "Confidential").
2. Open the **Twitch** page in the panel and register its **redirect URL** in the application
   exactly as shown (`<publicUrl>/api/p/twitch/auth/callback`). Twitch compares it character by
   character; plain `http` works only for `localhost` (not `127.0.0.1`), so a local `publicUrl`
   must use `http://localhost:<port>`.
3. Paste the application's **Client ID** into the plugin's settings and its **client secret**
   into the Secrets card on the same settings page.
4. **Connect broadcaster** while logged in to Twitch as the broadcaster.
5. **Connect bot**: Twitch asks which account to use (`force_verify`). Pick the bot account, or
   connect from a private window logged in as the bot. The bot must be a different account from
   the broadcaster: that is how the bot's own messages are told apart (`fromBot`).
6. Make the bot a moderator (`/mod <bot>`) for the higher rate limit, timeouts and deletions.

Only the owner can connect or disconnect accounts; mods see the page read-only. Changing the
client ID or secret reconnects; the accounts stay connected.

When Twitch refuses the client ID or secret (for example after **New Secret** in the Twitch
console without saving it here), the Application card says so and the log gets one warning.
Stream events keep working on the accounts' tokens; sending fails with `provider-error` until the
current secret is saved.

## What each account grants

| Account     | Scope                            | Why                                                        |
| ----------- | -------------------------------- | ---------------------------------------------------------- |
| broadcaster | `channel:bot`                    | Lets the app send in the channel with its "Chat Bot" badge |
| broadcaster | `moderator:read:followers`       | Follows                                                    |
| broadcaster | `channel:read:subscriptions`     | Subscriptions, resubscriptions, gifts                      |
| broadcaster | `bits:read`                      | Cheers                                                     |
| broadcaster | `moderation:read`                | Whether the bot is a moderator (and when that changes)     |
| broadcaster | `channel:read:vips`              | Whether the bot is a VIP (and when that changes)           |
| bot         | `user:bot`, `user:write:chat`    | Sending as the bot, with the app token                     |
| bot         | `user:read:chat`                 | Reading the channel's chat                                 |
| bot         | `moderator:manage:chat_messages` | `chat.delete`                                              |
| bot         | `moderator:manage:banned_users`  | `chat.timeout`                                             |

Stream events (online, offline, follows, subscriptions, gifts, raids, cheers) need only the
broadcaster. Chat waits for the bot.

## Chat

- Connection key `twitch:<broadcaster login>`, the default connection for `{ platform: 'twitch' }`.
- Messages are sent with the **app token**, so they carry Twitch's "Chat Bot" badge. Replies
  are native (`delivery: 'native'`).
- **Rate limits**, per channel: a bot that is a moderator or VIP sends up to 100 messages per
  30 s; otherwise 20 per 30 s and at most one per second. PetalBot uses 90% of that, queues up to
  20 sends for at most 10 s, and follows the bot's role live (moderator and VIP events). When
  Twitch still drops a message for its rate limit, sending pauses for 30 s.
- **Failures** (see the [chat failure contract](../chat/README.md#failure-contract)):

| Twitch answer                         | Failure                                |
| ------------------------------------- | -------------------------------------- |
| Message dropped for the rate limit    | `rate-limited`                         |
| Message dropped for any other reason  | `message-rejected`                     |
| 401 / 403 (bot lacks the permission)  | `permission-denied`                    |
| 404 on delete / timeout               | `message-not-found` / `user-not-found` |
| 400 naming the reply's parent message | `message-not-found`                    |
| Anything else                         | `provider-error`                       |

Twitch's own wording is kept in the failure's diagnostic `message`, never shown as UI copy. Every
dropped or refused request is also logged at warn level with Twitch's code and reason.

## The `twitch` contract

Only what the domains can't express:

| Member                           | What                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `twitch.connectionChanged`       | An account, the bot's role or an EventSub connection changed (panel)        |
| `twitch.cheer`                   | `{ source, user?, bits, message }`; also arrives as `stream.support`        |
| `twitch.status()`                | Accounts, "Reconnect required", rejected credentials, bot role, EventSub    |
| `twitch.disconnect({ account })` | Revokes the token at Twitch (best effort) and forgets the account (`owner`) |

## Tokens

Tokens are stored encrypted per Twitch user id and refreshed automatically. When the app is
disconnected at twitch.tv/settings/connections, Twitch ends the account's EventSub subscriptions
(`authorization_revoked`) and the account shows **Reconnect required** at once; the same happens
when Twitch refuses a refresh token. A bot account then drops chat, a broadcaster account stops
everything until it is reconnected. A restart tries the stored token again. Other refresh
failures (network, Twitch down) keep the account and retry after a minute; a refresh refused
because of the client secret counts as rejected credentials, not as a dead account.

Nothing the plugin logs about Twitch contains the client secret, tokens or OAuth codes: Twurple's
error messages quote request URLs, so they are redacted first.

## Limitations

- `stream.online` has no title or category yet.
- Repeated EventSub notifications are dropped by Twurple within one connection; a duplicate
  delivered across a reconnect of the whole plugin (new credentials) is not caught.
- In a shared chat session, messages from the other channels are ignored.
- The message timestamp is when PetalBot received it.

## Code map

| File                   | Role                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `src/contract.ts`      | The `twitch` contract and its types                                       |
| `src/scopes.ts`        | Scopes per account and the chat limits                                    |
| `src/twitch-client.ts` | The only Twurple import: `TwitchClient`, plain data in and out            |
| `src/mapping.ts`       | EventSub notifications -> domain pushes                                   |
| `src/oauth.ts`         | Authorize URL, single-use login states, redirects back to the page        |
| `src/runtime.ts`       | One running connection: listener, stream and chat providers, bot role     |
| `src/chat-provider.ts` | `chat.platform` methods and the failure mapping                           |
| `src/plugin.ts`        | Wiring: routes, rebuilds on changes, token refresh, `status`/`disconnect` |
| `src/server.ts`        | The entry: the plugin with the real Twurple client                        |
| `src/panel.tsx`        | The Twitch page                                                           |

Tests run against `test/fake-client.ts`; nothing in `pnpm check` talks to Twitch.
