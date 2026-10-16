# chat

The chat domain: one chat API over every platform. Consumers send and read chat through it;
platform plugins (`twitch`, later others) implement it. How the pieces fit:
[docs/plugin-guide.md, section 12](../../docs/plugin-guide.md#12-platforms-and-providers).

Depend on it with `"chat": "^1.0.0"` in `petalbot.dependencies` and
`"@petalbot-plugin/chat": "workspace:*"`, and import the contract from
`@petalbot-plugin/chat/contract`.

## For consumers

| Member                                               | What it does                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| event `chat.message`                                 | A `ChatMessage`: `id`, `source`, `user` (with `badges`), `text`, `replyTo?`, `timestamp`, `fromBot`.                                                          |
| event `chat.messageDeleted`                          | `{ source, messageId }`: a moderator or the platform removed a message.                                                                                       |
| event `chat.connectionsChanged`                      | A connection came, changed or went.                                                                                                                           |
| hook `chat.beforeSend`                               | `{ connection, text, replyTo?, caller }` before every send and reply; rewrite `text` or veto (`forbidden`).                                                   |
| `chat.send({ target, text })`                        | `Result<{ messageId }>`. Exposed to the panel (`mod`).                                                                                                        |
| `chat.reply({ to, text })`                           | `Result<{ messageId, delivery: 'native' \| 'mention' }>`; `to` is the message (a whole `ChatMessage` fits).                                                   |
| `chat.broadcast({ text, platforms?, connections? })` | One `Result<{ messageId }>` per connection, sent in parallel. Without filters: every connection; a requested connection that isn't there answers `not-found`. |
| `chat.delete({ target, messageId })`                 | `Result`. Skips the hook.                                                                                                                                     |
| `chat.timeout({ target, userId, seconds, reason? })` | `Result`. Skips the hook.                                                                                                                                     |
| `chat.connections()`                                 | `ConnectionInfo[]`: `id`, `platform`, `channel`, `displayName`, `isDefault`, `capabilities`. Query, `mod`.                                                    |
| `chat.recent()`                                      | The last 50 messages since chat started, oldest first, `deleted` marked. Query, `mod`.                                                                        |

A target is `{ connection: 'twitch:roman' }` or `{ platform: 'twitch' }` (that platform's
default connection, or its only one; otherwise `not-found`). Text is trimmed and must not be
empty. Skip messages with `fromBot`: they come from the bot's own account.

## For platform plugins

1. `ctx.provide('chat.platform', '<platform>:<channel>', impl)`: `send`, `reply`, `delete`,
   `timeout`, all optional, each answering a `Result`. A missing method makes the domain answer
   `unsupported`; a throwing one, `platform-error`.
2. `chat.registerConnection({ id, platform, channel, displayName, isDefault })`: only from the
   plugin providing `id`, and `id` must start with `<platform>:`.
3. `chat.ingest(message)` and `chat.ingestDeleted({ source, messageId })`: only for connections
   the calling plugin registered. A message id the domain already has for that connection is
   dropped (platforms may deliver twice).

List `chat` as a required dependency: optional dependents aren't restarted with it. A connection ends when its provider is disposed or its plugin stops; register again after
providing again.

## Panel

The **Chat** widget (`mod`) shows `chat.recent` live, sets the bot's messages apart, strikes
deleted ones through and has a send box. With several connections it names each message's
connection and offers a picker for where to send.
