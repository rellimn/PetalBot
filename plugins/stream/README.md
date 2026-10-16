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
| `stream.status()` | `{ [connection]: { live, since? } }` for every registered connection.              |

Both are queries exposed to the panel (`mod`).

## For platform plugins

List `stream` as a required dependency: optional dependents aren't restarted with it.

1. `ctx.provide('stream.platform', '<platform>:<channel>', {})`: no methods yet; it ties the
   connection to your plugin.
2. `stream.registerConnection({ id, platform, channel, displayName, live?, since? })`: only from
   the plugin providing `id`; pass `live: true` (and `since`) when the stream is already running, also when registering
   again.
3. `stream.ingest({ type, source, ... })`, e.g. `{ type: 'follow', source, user }`: only for
   connections the calling plugin registered. Stream emits `stream.<type>` without `type`. Pass
   the platform's start time as `since` with `online`; a repeated `online` keeps the first one.

## Panel

The **Activity** widget (`mod`) shows whether each connection is live and the latest events,
live.
