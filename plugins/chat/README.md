# chat

The chat domain: one chat API over every platform. Consumers send and read chat through it;
platform plugins (`twitch`, later others) implement it. How the pieces fit:
[docs/plugin-guide.md, section 12](../../docs/plugin-guide.md#12-platforms-and-providers).

Depend on it with `"chat": "^2.0.0"` in `petalbot.dependencies` and
`"@petalbot-plugin/chat": "workspace:*"`, and import the contract from
`@petalbot-plugin/chat/contract`.

## For consumers

| Member                                               | What it does                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| event `chat.message`                                 | A `ChatMessage`: `id`, `source`, `user` (with `badges`), `text`, `replyTo?`, `timestamp`, `fromBot`.                                                        |
| event `chat.messageDeleted`                          | `{ source, messageId }`: a moderator or the platform removed a message.                                                                                     |
| event `chat.connectionsChanged`                      | A connection came, changed or went.                                                                                                                         |
| hook `chat.beforeSend`                               | `{ connection, text, replyTo?, actor }` before every send and reply; rewrite `text` or veto (`forbidden`).                                                  |
| `chat.send({ target, text })`                        | `SendResult`. Exposed to the panel (`mod`).                                                                                                                 |
| `chat.reply({ to, text })`                           | `ReplyResult` (success includes `messageId` and `delivery: 'native' \| 'mention'`); `to` is the message (a whole `ChatMessage` fits).                       |
| `chat.broadcast({ text, platforms?, connections? })` | One `BroadcastItemResult` per connection, sent in parallel. Without filters: every connection; a requested connection that isn't there answers `not-found`. |
| `chat.delete({ target, messageId })`                 | `Result`. Skips the hook.                                                                                                                                   |
| `chat.timeout({ target, userId, seconds, reason? })` | `Result`. Skips the hook.                                                                                                                                   |
| `chat.connections()`                                 | `ConnectionInfo[]`: `id`, `platform`, `channel`, `displayName`, `isDefault`, `capabilities`. Query, `mod`.                                                  |
| `chat.recent()`                                      | The last 50 messages since chat started, oldest first, `deleted` marked. Query, `mod`.                                                                      |

A target is `{ connection: 'twitch:roman' }` or `{ platform: 'twitch' }` (that platform's
default connection, or its only one; no connection is `platform-not-connected`, ambiguity is `ambiguous-target`). Text is trimmed and must not be
empty. Skip messages with `fromBot`: they come from the bot's own account.

## For platform plugins

1. `const conn = ctx.provide('chat.platform', '<platform>:<channel>', { info, methods })`. The key is
   the connection id (its platform comes from the key); `info` is `{ channel, displayName,
isDefault }`. `methods` are `send`, `reply`, `delete` and `timeout`, all optional, each answering
   a `Result`. A missing method makes the domain answer `unsupported`; a throwing one, or one that
   takes longer than its timeout (12 s for `send`/`reply`, 5 s otherwise), `platform-error`.
2. `conn.push('message', message)` (a `ChatMessage` without `source`; chat adds it from the key) and
   `conn.push('messageDeleted', { messageId })`. A malformed push throws at once. A message id the
   domain already has for that connection is dropped (platforms may deliver twice).
3. `conn.update(info)` replaces the info, e.g. when the default connection changes.

A connection exists as long as its provider does: it ends when the provider is disposed or its
plugin stops, and it survives a restart of `chat` without any further call.

## Panel

The **Chat** widget (`mod`) shows `chat.recent` live, sets the bot's messages apart, strikes
deleted ones through and has a send box. With several connections it names each message's
connection and offers a picker for where to send.

## Failure contract

Each failure is `{ ok: false, reason, error: { code, ...details }, message? }`. `message` is
optional diagnostics. Generic clients handle the closed category; dependants narrow the exact
operation's `error.code`. Platform implementers import the definitions below from the contract,
except `rateLimitedFailure` from `@petalbot/sdk`. Private platform variants cannot be returned.

| Definition / code                                  | Category         | Details                                  |
| -------------------------------------------------- | ---------------- | ---------------------------------------- |
| `connectionNotFound` / `connection-not-found`      | `not-found`      | `connection`                             |
| `platformNotConnected` / `platform-not-connected`  | `not-found`      | `platform`                               |
| `ambiguousTarget` / `ambiguous-target`             | `custom`         | `platform`, `connections` (at least two) |
| `unsupportedCapability` / `unsupported-capability` | `unsupported`    | `connection`, `capability`               |
| `sendVetoed` / `send-vetoed`                       | `forbidden`      | `connection`, `vetoedBy`                 |
| `providerError` / `provider-error`                 | `platform-error` | `connection`, `capability`               |
| `permissionDenied` / `permission-denied`           | `forbidden`      | none                                     |
| `messageRejected` / `message-rejected`             | `platform-error` | `cause?` (`duplicate`)                   |
| `messageNotFound` / `message-not-found`            | `not-found`      | `messageId`                              |
| `userNotFound` / `user-not-found`                  | `not-found`      | `userId`                                 |
| `rateLimitedFailure` / `rate-limited`              | `rate-limited`   | none                                     |

For the exact composition below:

- **R** = connection-not-found, platform-not-connected, ambiguous-target.
- **S** = permission-denied, rate-limited, message-rejected, provider-error.
- **P** = S + message-not-found.
- **D** = permission-denied, message-not-found, provider-error.
- **T** = permission-denied, user-not-found, provider-error.

| Surface          | Exact failures                                                  |
| ---------------- | --------------------------------------------------------------- |
| Provider send    | S                                                               |
| Provider reply   | P                                                               |
| Provider delete  | D                                                               |
| Provider timeout | T                                                               |
| RPC send         | R + unsupported-capability + send-vetoed + S                    |
| RPC reply        | connection-not-found + unsupported-capability + send-vetoed + P |
| Broadcast item   | connection-not-found + unsupported-capability + send-vetoed + S |
| RPC delete       | R + unsupported-capability + D                                  |
| RPC timeout      | R + unsupported-capability + T                                  |

For M5c: Helix send rate-limit drops map to `rateLimitedFailure`, other send drops to
`messageRejected`, permission refusals to `permissionDenied`, identifiable missing messages to
`messageNotFound` on reply/delete, identifiable missing users to `userNotFound` on timeout, and
other request failures to `providerError`. Unexpected provider exceptions are logged and become
that same `providerError` at the bridge. Rate limiting and reply fallback remain provider-owned.

The panel explicitly presents vetoes and stale connections with contextual copy and retains the
draft on failure; other variants use category fallbacks. Diagnostics are never automatic UI copy.
Chat is contract/package `3.0.0`, targeting `petalbot.apiVersion: 3`.
