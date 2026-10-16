# stream

The stream domain: community events from every platform in one shape. Platform plugins
(`twitch`, later others) feed it; consumers (alerts, stats) listen. How the pieces fit:
[docs/plugin-guide.md, section 12](../../docs/plugin-guide.md#12-platforms-and-providers).

Depend on it with `"stream": "^1.0.0"` in `petalbot.dependencies` and
`"@petalbot-plugin/stream": "workspace:*"`, and import the contract from
`@petalbot-plugin/stream/contract`.

## For consumers

Every event carries `source: { platform, connection }`. Users are
`StreamUser { id, login, displayName }`.

| Event                       | Payload besides `source`                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `stream.online`             | `since?` (start time), `title?`, `category?`                                        |
| `stream.offline`            | none                                                                                |
| `stream.follow`             | `user`                                                                              |
| `stream.subscription`       | `user`, `tier` (1, 2, 3), `months?`, `message?`                                     |
| `stream.giftSubscription`   | `gifter?` (missing: anonymous), `count`, `tier`                                     |
| `stream.raid`               | `from`, `viewers`                                                                   |
| `stream.support`            | `user?` (missing: anonymous), `amount`, `currency` (`EUR`, `bits`, ...), `message?` |
| `stream.connectionsChanged` | none: a connection came, changed or went                                            |

| RPC               | What it returns                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- |
| `stream.recent()` | The last 30 events since stream started, newest first: `{ id, timestamp, event }`. |
| `stream.status()` | `{ [connection]: { live, since? } }` for every connection.                         |

Both are queries exposed to the panel (`mod`).

## For platform plugins

1. `const conn = ctx.provide('stream.platform', '<platform>:<channel>', { info })`. The key is the
   connection id; `info` is `{ channel, displayName, live?, since? }`: pass `live: true` (and
   `since`) when the stream is already running. No methods yet.
2. `conn.push('event', { type, ... })`, e.g. `{ type: 'follow', user }`. Stream adds `source` from
   the key and emits `stream.<type>` without `type`. Pass the platform's start time as `since` with
   `online`; a repeated `online` keeps the first one. Stream doesn't de-duplicate events: the
   platform must (Twitch: by EventSub message id).
3. `conn.update(info)` replaces the info; its `live`/`since` become the connection's status.

A connection exists as long as its provider does, and survives a restart of `stream`.

## Panel

The **Activity** widget (`mod`) shows whether each connection is live and the latest events,
live.
