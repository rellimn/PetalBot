# PetalBot Plugin API (apiVersion 3)

This is the reference for plugin authors. The browser-facing APIs are generated:
`docs/api/openapi.json` (HTTP) and `docs/api/asyncapi.json` (WebSocket). The UI SDK
(components, tokens, client) is described in `docs/api/ui-sdk.md`.

Plugins import `@petalbot/sdk` (server and contracts) and `@petalbot/ui-sdk` (panel code), never `@petalbot/core`.

## Package and manifest

A plugin is a workspace package. `package.json` names the plugin and its dependencies:

```jsonc
{
  "name": "@petalbot-plugin/alerts",
  "version": "1.0.0", // = the contract version
  "scripts": { "build": "vite build", "dev": "vite build --watch" },
  "petalbot": {
    "id": "alerts", // ^[a-z][a-z0-9-]*$, not "core" or "petalbot"
    "apiVersion": 3,
    "dependencies": { "stream": "^1.0.0" }, // ranges match dependency contract versions
    "optionalDependencies": {},
  },
}
```

The entries come from the build: `vite build` writes them to `dist/build.json` (see
"Building"). A plugin without that file is listed in Admin > Plugins as "Not built". Every
overlay the contract declares needs a built `src/overlays/<name>.tsx`, or the plugin doesn't
start.

The ids listed under `dependencies` and `optionalDependencies` must match the contracts passed to `definePlugin`.

## Creating a plugin

`pnpm create-plugin <id> [--no-panel] [--db] [--overlay <name>]…` writes `plugins/<id>/` (a tiny
working plugin: one setting, a read and a write RPC, one event, a live page and widget, tests),
installs it, generates the first migration with `--db` and builds it once. A running `pnpm dev`
picks it up within seconds. [docs/plugin-guide.md](../plugin-guide.md) walks through every file.

## Contracts: `defineContract`

```ts
export const alertsContract = defineContract({
  id: 'alerts',
  version: '1.0.0',
  settings: z.object({ volume: z.number().min(0).max(100).default(50) }),
  secrets: {
    apiKey: { userSettable: true, label: 'API key', description: 'From the vendor dashboard' },
    tokens: { schema: Token, keyed: true }, // internal: one value per key
  },
  events: { shown: { schema: Alert, expose: ['panel', 'overlay'] } },
  hooks: { beforeShow: { input: Alert, failClosed: false } },
  rpc: {
    recent: { kind: 'query', output: z.array(Alert), expose: { panel: 'mod', overlay: true } }, // no input

    clear: { output: Result(z.object({}), []), expose: { panel: 'owner' }, timeoutMs: 10_000 },
  },
  providers: {
    sink: {
      key: ConnectionId,
      info: z.object({ label: z.string() }),
      methods: { show: { input: Alert, output: z.object({}), timeoutMs: 8000 } },
      inbound: { dismissed: z.object({ alertId: z.string() }) },
    },
  },
  widgets: { latest: { config: z.object({ count: z.number().int().default(3) }) } },
  overlays: {
    box: {
      dependencies: [streamContract],
      config: z.object({ durationMs: z.number().default(5000) }),
      events: ['stream.follow', 'alerts.shown'],
      rpc: ['alerts.recent'],
    },
  },
});
```

| Member      | Meaning                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings`  | Settings schema, typed everywhere (server `ctx.settings`, custom settings forms, the test harness). Every field needs a default.                                                                                                                                                                             |
| `secrets`   | Credentials, encrypted at rest. `userSettable: true` secrets are plain strings the owner enters in the panel's Secrets card (needs `label`, no `schema`); internal ones default to a string, may declare a JSON-safe `schema`, and `keyed: true` holds one value per key. Names follow the member-name rule. |
| `events`    | Fire-and-forget fan-out. Only the owner emits. `expose` makes an event reachable from the panel and/or overlays.                                                                                                                                                                                             |
| `hooks`     | Awaited, ordered pipeline that can modify or veto. Only the owner runs it; dependents tap it. Browsers never see hooks.                                                                                                                                                                                      |
| `rpc`       | Request/response, validated both ways. `kind: 'query'` marks a read that clients may repeat freely (`useQuery`); without it the RPC is a mutation (`useMutation`). `expose.panel` is the minimum role; `expose.overlay: true` allows overlays.                                                               |
| `providers` | Slots dependents provide into, one registration per key. Up to four parts: `key` (a string schema for the keys), `info` (an object schema each registration carries; required when declared), `methods` (owner -> provider, each optional for implementers) and `inbound` (provider -> owner pushes, by name). |
| `widgets`   | Every dashboard widget, with an optional per-instance `config`. Titles and components live in `definePanel`.                                                                                                                                                                                                 |
| `overlays`  | Each overlay's instance config and the exact events and RPCs it may use. Names must be exposed to `overlay` and come from the own contract or the overlay's `dependencies`. Wrong names are compile errors and also fail at runtime. Overlay names match `^[a-z][a-z0-9-]*$`.                                |

RPCs without `input` take none: `ctx.call('alerts.recent')`. An RPC or a provider method may declare
`timeoutMs` (an integer from 1 to 120 000): how long callers wait by default. A caller's own
`timeoutMs` wins; otherwise the default is 5 s.

**Flow marks** (read by the flow engine from M6a on; inert until then): an event may declare
`flow: { label, description?, filter? }` (a trigger; `filter` names top-level payload fields), an
RPC `flow: { label, description?, retryable? }` (a mutation is a step, a query a value;
`retryable: true` promises that a `rate-limited` failure of the whole RPC changed nothing and is
for mutations only). Member names must be unique across
`events`, `hooks`, `rpc` and `providers`. `choice('<own rpc>')` makes a string field whose valid
values an own RPC lists at runtime (`kind: 'query'`, no input, output `Choices`, `expose.panel`). It's allowed in
top-level fields of `settings`, widget `config` and overlay `config`.

Versioning:

- Adding members or optional fields is a minor version.
- Changing an RPC's `kind` is a major version: clients switch between `useQuery` and `useMutation`.
- Removing or renaming anything, making a field required, changing a type, or adding a literal to a closed union (including an operation's failure codes or SDK `FailureReason` categories) is a major version.

## Server entry: `definePlugin`

```ts
export default definePlugin(alertsContract, {
  dependencies: [streamContract] as const,
  kv: { shownCount: z.number() },
  db: { schema }, // migrations: <plugin>/drizzle by default (`db: { schema, migrations: 'other' }`)
  setup(ctx) {
    ctx.on('stream.follow', (event) => ctx.emit('alerts.shown', toAlert(event.payload)));
    return {
      rpc: {
        recent: (_input, { who }) => [],
        clear: () => ok({}),
      },
    };
  },
});
```

`setup` returns the RPC implementations. Every RPC of the contract must be implemented (checked at
compile time and at start), and they become callable once `setup` has resolved; calls before that
fail with `PluginUnavailableError`. Each implementation gets `(input, { caller, client, who, actor, via })`:

- `caller` is the calling plugin's id, or `'client'` for calls from a browser.
- `client` is then `{ kind: 'panel', user: { id, name, role } }` or `{ kind: 'overlay', instanceId }`.
- `actor` is who caused the call (`Actor` from `@petalbot/sdk`): `{ kind: 'user', user }`,
  `{ kind: 'overlay', instanceId }`, `{ kind: 'plugin', pluginId }`, `{ kind: 'viewer', viewer }`
  or `{ kind: 'flow', flowId, name }`. It travels along nested calls, hooks and the events they
  emit (envelopes carry `actor` too); a plugin acting on its own is the actor of its calls.
- Tasks of `ctx.schedule` run as the plugin itself, also when armed during a call. Timers,
  sockets and callbacks a plugin creates by hand inherit the actor of the code that created them,
  so create long-lived ones in `setup` or use `ctx.schedule`.
- `via` names what acted on the actor's behalf (`{ kind: 'flow', flowId, name, runId }`), if anything.
- `who` is `describeActor(actor)`: the user's or viewer's name, `'overlay'`, a plugin id or a flow name.

## `ctx` reference

| Member                                                                                    | Description                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`, `log`                                                                         | The plugin id and a pino child logger tagged with it.                                                                                                                                                                                                                                                                                                         |
| `on(event, handler)`                                                                      | Own and (optional) dependency events. Each subscription has its own FIFO queue.                                                                                                                                                                                                                                                                               |
| `emit(event, payload)`                                                                    | Own events only. Validated synchronously; an invalid payload throws `ValidationError`.                                                                                                                                                                                                                                                                        |
| `hook(name, handler, { priority })` / `runHook(name, input)`                              | Tap a hook / run an own hook. A handler returns the modified input, nothing, or `veto(reason)`.                                                                                                                                                                                                                                                               |
| `call(rpc, input?, { timeoutMs })`                                                        | Dependency RPCs (timeout: the option, else the RPC's `timeoutMs`, else 5 s); RPCs without input take none. Throws `ValidationError`, `PluginUnavailableError`, `RpcTimeoutError`.                                                                                                                                                                             |
| `provide(slot, key, { info, methods })`                                                   | Register in a dependency's slot. Validates `key` and `info` (required when the slot declares it). Returns `{ key, push(name, payload), update(info), dispose() }`: `push` validates at once and delivers to the owner in order; `update` replaces the info; both are no-ops after `dispose`.                                                                   |
| `providers(slot)`                                                                         | Resolve an own slot: `keys()`, `list()`, `get(key)` (handles with `info`, `methods`, `has` and `call`, which applies the method's timeout and throws `ProviderTimeoutError`), `on(name, (payload, provider) => ...)` for pushes (one queue per plugin and slot) and `onChange(fn)` with `{ key, pluginId, change: 'added' \| 'updated' \| 'removed' }`, also when the implementing plugin stops (no replay). |
| `settings.get()` / `settings.onChange(fn)`                                                | Validated settings; the panel edits them.                                                                                                                                                                                                                                                                                                                     |
| `kv.get/set/delete(key)`                                                                  | Declared keys only; values must survive JSON. `set(key, undefined)` deletes.                                                                                                                                                                                                                                                                                  |
| `kv.update(key, updater)`                                                                 | Atomic read-modify-write: a synchronous `updater(current)` runs in one transaction; `undefined` deletes. A throwing, async or invalid updater writes nothing.                                                                                                                                                                                                 |
| `lock(key, fn)`                                                                           | Runs `fn` one at a time per key (FIFO); for async read-call-write sections. Waiting calls reject when the plugin stops.                                                                                                                                                                                                                                       |
| `secrets.get/set/delete(name, [key])`, `secrets.keys(name)`, `secrets.onChange(name, fn)` | Declared secrets only. Keyed secrets take a key (1-128 characters) after the name. `onChange` runs after every write (panel or plugin, deletes too) and gets the key for keyed secrets. Values never reach the panel.                                                                                                                                         |
| `db`                                                                                      | Drizzle database for plugins that declare `db`. Tables must be prefixed `<pluginId>_`.                                                                                                                                                                                                                                                                        |
| `schedule.after/every/cron`                                                               | Timers that never overlap and are disposed on stop.                                                                                                                                                                                                                                                                                                           |
| `http.route(method, path, handler, options)`                                              | See below.                                                                                                                                                                                                                                                                                                                                                    |
| `http.url(path)`                                                                          | The absolute public URL of an own route path, e.g. for OAuth redirects: `ctx.http.url('/auth/callback')`.                                                                                                                                                                                                                                                     |
| `isRunning(id)`                                                                           | For optional dependencies.                                                                                                                                                                                                                                                                                                                                    |
| `onDispose(fn)`                                                                           | Custom teardown. Everything registered through `ctx` is disposed automatically, in reverse order.                                                                                                                                                                                                                                                             |

After the plugin stops, every `ctx` method throws `PluginUnavailableError`.

**Concurrent writes:** use `kv.update` when the new value depends only on the old one, a single SQL
statement (`UPDATE … SET value = value + ? RETURNING`) or a synchronous `ctx.db.transaction(…)` for
the DB, and `lock` only when an `await` must sit between the read and the write.

## HTTP routes

```ts
ctx.http.route(
  'POST',
  '/webhook/:id',
  async (request, { params, user }) => {
    const body = await request.json();
    return Response.json({ ok: true, id: params.id });
  },
  { public: true },
);
```

- Routes are mounted at `/api/p/<pluginId><path>`. `:name` captures a path segment.
- Methods are `GET`, `POST`, `PUT`, `PATCH` and `DELETE`.
- By default a route requires a panel login with at least `role` (default `'mod'`). State-changing requests also need the panel's `Origin`.
- `{ public: true }` skips both the login and the Origin check (webhooks, OAuth callbacks). `user` is still set when someone is logged in.
- A handler that throws, or returns no `Response`, answers 500 `internal` and counts toward the plugin's `degraded` flag.
- While the plugin is stopped, its routes answer 404 `unavailable`.
- Request bodies are limited to 1 MiB.

## Secrets

```ts
setup(ctx) {
  ctx.secrets.onChange('apiKey', () => restartClient());
  const key = await ctx.secrets.get('apiKey'); // string | undefined
  await ctx.secrets.set('tokens', userId, { accessToken, refreshToken }); // validated by its schema
  for (const id of await ctx.secrets.keys('tokens')) { /* ... */ }
}
```

- The owner sets user-settable secrets on the plugin's settings page (Secrets card): a password field, Replace and Clear. Surrounding whitespace is trimmed; an empty value deletes. The panel only ever sees whether a value is set.
- Plugin code never handles secret values for the panel; the core renders the card, also below a custom settings form.
- The owner-only HTTP API is `GET /api/plugins/{id}/secrets` and `PUT|DELETE /api/plugins/{id}/secrets/{name}` (see `openapi.json`).
- "Delete data" removes every secret of the plugin.
- `onChange` also fires for the plugin's own writes, and `set`/`delete` wait for the listeners. A listener that writes the secret it listens to calls itself again: guard it, or listen only to the secrets the owner sets (e.g. restart a client on `clientSecret`, not on `tokens`).
- Schema secrets follow the KV rule: values must survive JSON unchanged, so leave out optional fields instead of setting them to `undefined`.

## Building: `petalbotPlugin()`

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { petalbotPlugin } from '@petalbot/tooling/vite';

export default defineConfig({ plugins: petalbotPlugin() });
```

`vite build` writes:

- `dist/server/server.js` from `src/server.ts`. It is one file with the plugin's own modules
  inlined, so a reload re-imports everything. Package dependencies stay external.
- `dist/panel/panel.js` (+ `panel.css`) from `src/panel.tsx`, if that file exists.
- `dist/overlays/<name>/<name>.js` (+ `<name>.css`) for every `src/overlays/<name>.tsx`. Each
  overlay is its own bundle; file names must be overlay names (`^[a-z][a-z0-9-]*$`).
- `dist/build.json` once everything is written: `{ builtAt, entries: { server?, panel?, overlays } }`.
  The core discovers the plugin's entries from it. `vite build --watch` rewrites it after every
  successful rebuild, never after a failed one; a new overlay file needs a restart of the watcher.

Browser bundles are built with the React Compiler. With `dev: true` in the config, the core
reloads a running plugin when its `dist/build.json` changes (and restarts it if it failed), and
picks up new plugin folders once they're built: plugins with no stored enabled/disabled choice
start enabled. Without `dev`, new plugins start disabled; use Admin > Plugins > Reload after a
rebuild.

The core reads the bundle folders into memory when the plugin starts and serves only that copy,
so a rebuild never mixes old and new files. A bundle folder must not contain the server entry,
symbolic links in it are ignored, and all bundles of a plugin together may be at most 20 MiB.

The panel and the overlay host provide these modules to plugin bundles through an import map:
`react`, `react-dom`, `react/jsx-runtime`, `react/compiler-runtime`, `zod`, `@petalbot/sdk` and
`@petalbot/ui-sdk`. Use named imports from them (no default import of `zod`). Do not bundle a
second copy of `@tanstack/react-query`; use the clients below.

## Panel entry: `definePanel`

```tsx
// src/panel.tsx
import { Quote } from 'lucide-react';
import { definePanel, type WidgetProps } from '@petalbot/ui-sdk';

function LatestQuote({ config }: WidgetProps<typeof quotesContract, 'latest'>) { … }

export default definePanel(quotesContract, {
  pages: [{ path: 'list', title: 'Quotes', icon: Quote, minRole: 'mod', component: QuotesPage }],
  // One entry per widget the contract declares (`widgets` in the contract), keyed by its id.
  widgets: {
    latest: { title: 'Latest quote', minRole: 'mod', component: LatestQuote },
  },
  settings: CustomSettingsForm, // optional; otherwise the panel generates a form
});
```

| Field          | Meaning                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pages[].path` | URL under `/p/<pluginId>/`, lower-case segments, e.g. `list` or `list/archive`.                                                                                                                                                |
| `pages[].icon` | A component such as a `lucide-react` icon (only the icons you import are bundled).                                                                                                                                             |
| `minRole`      | `'owner'` (default) or `'mod'`, for pages and widgets. The server still checks every RPC.                                                                                                                                      |
| `widgets`      | Keys must equal the contract's widget ids; a mismatch is a compile error and fails at load. The component gets `WidgetProps` (`{ config, instanceId }`); an optional `configure` component replaces the generated config form. |
| `settings`     | A component with `SettingsFormProps<typeof contract>` (`values`, `schema`, `save(patch)`); `save` rejects with `ApiError` (`issues` for validation).                                                                           |

Pages and widgets render inside an error boundary. While the plugin is stopped, pages show
"not running" and widgets a placeholder; both come back by themselves. Widget instances, their
configure dialog, "Needs configuration" and the title suffix are described in
`docs/api/ui-sdk.md` (Widgets and settings).

## Panel client: `createPluginClient`

The client is described in `docs/api/ui-sdk.md` (Client). Whether an RPC gets `useQuery` or
`useMutation` comes from its `kind` in the contract; the definition only says how queries stay
fresh. The counter's `src/client.ts` is the worked example:

```ts
export const api = createPluginClient(counterContract, {
  queries: {
    'counter.list': { refreshOn: ['counter.listChanged'] },
    'counter.get': {
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (data, event, input) =>
          data !== null && event.payload.counter === input.counter
            ? { ...data, value: event.payload.value }
            : data,
      },
    },
  },
  mutations: { 'counter.increment': { invalidates: [] } },
});
```

Create the client at module scope: the React Compiler needs the hooks behind it to stay the same.

**Where state lives.** Data the server owns (values, queues, recent events) lives in the plugin's
server code and reaches the panel through live queries. Buffers built from events also belong on
the server: keep them there and expose a `recent()`-style RPC plus the event, so late mounts, new
tabs and overlays see them. Only pure UI state (drafts, filters, a selection shared by a widget and
a page) goes into a client store (`createStore`, ui-sdk.md). A plugin reload starts with fresh
stores.

Errors are `ClientError { code, message }` with the server's codes, plus `unavailable`
(connection lost; calls made while offline are sent after reconnecting), `timeout` and `unauthorized`.

## Panel styling

Use `@petalbot/ui-sdk` components and CSS Modules (`*.module.css`) with the `--pb-*` tokens only
(see `docs/api/ui-sdk.md`). No Tailwind: class names of runtime-loaded bundles would be missing from
the panel's CSS. Your bundle's stylesheet is loaded and unloaded with the plugin.

## Overlays: `defineOverlay` and `createOverlayClient`

An overlay is a page OBS shows as a browser source. Declare it in the contract (`overlays`, see
above), then write `src/overlays/<name>.tsx`:

```tsx
import {
  createOverlayClient,
  defineOverlay,
  type OverlayConfig,
  type OverlayProps,
} from '@petalbot/ui-sdk';
import { alertsContract } from '../contract.ts';

const box = createOverlayClient(alertsContract, 'box'); // module scope, like createPluginClient

function AlertBox({ config }: OverlayProps<OverlayConfig<typeof alertsContract, 'box'>>) {
  const [text, setText] = useState<string | null>(null);
  // An occurrence, not state: useEvent. Displayed state would use box.<id>.<rpc>.useQuery().
  box.stream.follow.useEvent((event) => {
    setText(`${event.payload.user} followed`);
    setTimeout(() => setText(null), config.durationMs);
  });
  return text === null ? null : <div className={styles.alert}>{text}</div>;
}

export default defineOverlay(alertsContract, 'box', { component: AlertBox });
```

- **Client:** `createOverlayClient(contract, name, { queries?, mutations? })` has exactly the events
  and RPCs the declaration lists (anything else is a compile error), with the same handles as
  the panel client (`box.<id>.<member>.useQuery/useMutation/call/useEvent`). The server enforces
  the same list.
- **Config:** the component gets `config`, parsed with the declaration's schema in the browser,
  so defaults are applied. It re-renders when the owner changes the instance's config. A stored
  config that no longer fits the schema renders nothing (and logs to the console).
- **Page:** the overlay is mounted on a transparent full-viewport page. Draw your own
  background, if any; use `--pb-*` tokens and CSS Modules as in the panel. While the plugin is
  stopped the page is empty; after a reload with new code it reloads itself.
- **Instances:** owners create instances in Admin > Overlays: each has a name, its own config
  and its own URL `/overlay/<plugin>/<overlay>/<instance>?t=<token>` for OBS. The token is shown
  once; rotating or revoking it disconnects open pages. The panel shows a live preview.
- **Public bundle:** overlay bundles are served without login (OBS has no session); do not put
  secrets into overlay code. Data comes only through the declared events and RPCs.

## Data that reaches the browser

Event payloads and RPC results travel as JSON. The server encodes them with their schema
(`z.encode`) and the panel and overlay clients decode them (`z.decode`), so your code works with
the schema's output type on both ends.

- Plain JSON values (strings, numbers, booleans, arrays, objects, enums, `Result`) need nothing.
  `z.coerce.date()` also works.
- For other values use a codec: `codecs.isoDate()` (a `Date`, an ISO string on the wire) and
  `codecs.bigintString()` from `@petalbot/sdk`, or your own `z.codec(wire, value, { decode, encode })`.
- One-way transforms (`.transform(…)`, `.pipe(z.coerce.…)`) and `z.date()`, `z.bigint()`,
  `Map`/`Set` cannot be encoded: such an event is not delivered to browsers (the core logs an
  error) and such an RPC answers `internal`.
- Inputs (`emit`, `call`, RPC inputs from the browser) are passed in the schema's input form, as
  everywhere in the SDK. With a codec field that is the wire form, e.g. an ISO string.
- If the browser receives something that does not match its contract (e.g. a dependency changed
  incompatibly), the event is dropped and the call rejects with `ClientError` code `validation`.

## Platform types

`@petalbot/sdk` exports the platform vocabulary every domain shares, as zod schemas with
same-named types:

- `PlatformId` (`twitch`, `^[a-z][a-z0-9-]*$`) and `ConnectionId` (`<platform>:<channel>`, e.g.
  `twitch:roman`).
- `Source` `{ platform, connection }`, and `Target`: `{ connection }` or `{ platform }`.
- `PlatformUser` `{ id, login, displayName }` and `Viewer` (a `PlatformUser` with its `platform`
  and `connection`).
- `Actor`, `Via` and `describeActor(actor)` (see the server entry).
- `sourceOf('twitch:roman')` returns `{ platform: 'twitch', connection: 'twitch:roman' }` and
  throws `TypeError` for anything that isn't a connection id.

## Rate limiting

Platform plugins limit their own outbound calls (spec §6.6):

```ts
const limiter = createRateLimiter({ limit: 20, windowMs: 30_000, maxQueue: 20, maxWaitMs: 10_000 });
ctx.onDispose(() => limiter.dispose());
const result = await limiter.schedule(() => api.send(text));
if (!result.ok) return result; // { ok: false, reason: 'rate-limited', error: { code: 'rate-limited' }, message? }
```

- Sliding window over task starts; the budget is `max(1, floor(limit * safetyFactor))` (default 0.9).
- Waiting tasks start in FIFO order. A full queue, or a start more than `maxWaitMs` away, is rejected at once; `rate-limited` always means "not attempted". A throwing task rejects `schedule` with its error.
- `setLimit(limit)` resizes (e.g. the bot became a moderator), `pause(ms)` starts nothing for a while (e.g. the platform reported a hit) and rejects waiting tasks that would expire, `stats()` returns `{ queued, remaining, limit }`, `dispose()` rejects everything waiting.

## Errors and results

Infrastructure failures throw `PetalBotError` subclasses: `ValidationError`,
`PluginUnavailableError`, `RpcTimeoutError`, `ProviderTimeoutError` (a provider method took longer
than its timeout; it may still complete afterwards), `AccessError`, `ContractVersionError`. Rejected
browser calls carry `{ code, message }`; `PetalBotError` messages pass through, other exceptions
become `internal`.

Expected domain outcomes use `Result(successObject, [failureDefinitions])`. Each operation
selects its exact possible failures. `[]` means success only; no failure is included implicitly.
Duplicate codes in one Result, an empty definition code, `code` in detail fields and `ok` in
success fields are rejected. The generic `Result<T, F = never>` likewise defaults to success only.

The SDK's closed `FailureReason` categories are `unsupported`, `forbidden`, `not-found`,
`rate-limited`, `platform-error`, `custom`. Generic consumers switch exhaustively on `reason`;
dependants switch on `error.code` for the operation's exact variants. Use `custom` when no
category fits, such as a domain queue being full. A new definition alone doesn't expand existing
operations; adding a variant to an operation is a breaking contract change.

```ts
// contract.ts: shared by producers, dependants and the browser
import { z } from 'zod';
import { defineFailure, Result } from '@petalbot/sdk';

export const groupNotFound = defineFailure({
  code: 'group-not-found',
  reason: 'not-found',
  details: z.object({ groupId: z.string() }),
});
export const entityNotFound = defineFailure({
  code: 'entity-not-found',
  reason: 'not-found',
  details: z.object({ groupId: z.string(), entityId: z.string() }),
});
export const ReadEntityResult = Result(z.object({ text: z.string() }), [
  groupNotFound,
  entityNotFound,
]);
export const queueFull = defineFailure({
  code: 'queue-full',
  reason: 'custom',
  details: z.object({ capacity: z.number().int().positive() }),
});
```

```ts
// producer: diagnostics are optional
import { fail } from '@petalbot/sdk';
import { entityNotFound } from './contract.ts';
const missing = fail(entityNotFound, { groupId: 'g', entityId: 'e' });
// { ok: false, reason: 'not-found', error: { code: 'entity-not-found', groupId: 'g', entityId: 'e' } }
```

```ts
// client.ts: presenters by code, typed from the contract
export const api = createPluginClient(contract, {
  failures: {
    'group-not-found': (failure) => `Group ${failure.error.groupId} no longer exists.`,
    'entity-not-found': (failure) =>
      `Entity ${failure.error.entityId} is missing from group ${failure.error.groupId}.`,
  },
});
// useMutation({ error: 'Could not read' }) presents with these; a mutation may override them
// with presentFailure. For a manually handled result: presentFailure(result, presenter)
```

`defineFailure` returns `code`, `reason` and `schema`. `fail(definition, details, message?)`
constructs that schema's **input**, without parsing it; the RPC/provider boundary validates it.
If a variable holds several possible definitions, narrow it by `definition.code` before calling
`fail` so the selected definition and required details stay correlated.
`message` is optional developer diagnostics, never automatic UI copy. Put only caller-appropriate
data in public details. Use client presenters plus category fallbacks (see
[UI SDK](ui-sdk.md#failure-presentation)); no diagnostic fallback exists.

A failure code names one definition per contract: `defineContract` rejects two different
definitions with the same code anywhere in its schemas (RPCs, providers, events, hooks, also
nested). Reusing one definition in several operations is fine. `failuresIn(schema)` returns the
definitions a schema contains.

Codec fields keep input/output distinct. For `{ at: codecs.isoDate() }`, producers supply an
ISO string and consumers receive a Date. A domain forwarding a decoded provider result through
a second boundary using the same schema must encode it first:

```ts
const providerResult = await provider.call('read', {}); // decoded: error.at is Date
return z.encode(ReadResult, providerResult); // RPC implementation returns schema input
```

Plain JSON details need no conversion. Error codecs are encoded by the gateway and decoded by
the browser just like success payloads. Unexpected codes, categories or invalid details fail
schema validation.

`createRateLimiter` returns the exported `rateLimitedFailure` definition's envelope on queue
rejection/disposal. Select it explicitly in any operation forwarding those outcomes:

```ts
import { rateLimitedFailure, Result } from '@petalbot/sdk';
const SendResult = Result(z.object({ messageId: z.string() }), [rateLimitedFailure]);
```

Provider slots own their failure schemas. Implementers import the owner's definitions and
translate private platform errors; they cannot add private codes to the slot's output. See the
[chat failure table](../../plugins/chat/README.md#failure-contract) for the concrete contract.

This migration requires SDK/UI SDK `1.0.0` and `petalbot.apiVersion: 2` (API 1 is rejected).
Chat is `2.0.0`, counter `4.0.0`; stream stays `1.0.0` and targets API 2. Rebuild plugins and
update actual dependency ranges to `chat: ^2.0.0` / `counter: ^4.0.0`.

The provider-slot change that followed (M5p) requires SDK `2.0.0` and `petalbot.apiVersion: 3`
(API 2 is rejected). Chat is `3.0.0`, stream `2.0.0`; counter stays `4.0.0`. See the server
entry and the `ctx` reference above.

## Defaults and limits

| What                         | Value                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `setup` timeout              | 10 s                                                                                   |
| RPC timeout                  | 5 s                                                                                    |
| Hook handler timeout         | 2 s (fail-open unless `failClosed`)                                                    |
| Event causation depth        | 16                                                                                     |
| Degraded                     | 10 failures within 60 s, or any uncaught error                                         |
| WebSocket                    | 64 KiB frames, 32 concurrent RPCs per socket                                           |
| Browser bundles              | ≤ 1000 files per bundle folder, ≤ 20 MiB per plugin; served only while the plugin runs |
| Log ring                     | last 2000 entries at the configured level                                              |
| Dashboard                    | 1–3 columns, ≤ 20 widgets per column, ≤ 20 presets per user                            |
| Secret keys                  | 1-128 characters                                                                       |
| Secret values from the panel | <= 16384 characters                                                                    |

## Testing

```ts
const harness = await createTestHarness(alertsPlugin, {
  fakes: { stream: { rpc: { recent: () => [] } } },
  settings: { volume: 10 }, // typed from the contract
});
harness.emit('stream.follow', { user: 'mia' });
await harness.idle();
expect(harness.events.map((e) => e.name)).toContain('alerts.shown');
await harness.call('alerts.recent'); // no input
await harness.updateSettings({ volume: 20 });
await harness.stop();
```

```ts
const harness = await createTestHarness(chatPlugin, {
  secrets: { apiKey: 'k', tokens: { '42': { accessToken: 'a' } } },
  providers: {
    'chat.platform': {
      'twitch:test': { info, methods: { send: async ({ text }) => ({ messageId: text }) } },
    },
  },
  publicUrl: 'https://bot.example.com',
});
await harness.setSecret('apiKey', 'k-2'); // fires onChange
const conn = harness.addProvider('chat.platform', 'twitch:other', { info, methods: fake });
conn.push('message', message); // as the platform would
conn.dispose();
const handle = harness.provider('chat.platform', 'twitch:main'); // implementer under test
await harness.idle();
harness.pushed('chat.platform', 'twitch:main'); // [{ name: 'message', payload }, ...]
```

`secrets` seeds stored values and `setSecret(name, [key,] value)` writes one as the panel would, firing `onChange`. `providers` fills the plugin's own slots with fakes before it starts; `addProvider` adds one mid-test and returns its registration (`push`, `update`, `dispose`). For a plugin that implements a dependency's slot, `provider(slot, key)` returns the handle the slot owner would see and `pushed(slot, key)` lists what it pushed. Fake providers and `harness.call` come from the same harness plugin.

`createTestHarness` (from `@petalbot/testing`) runs the plugin in a real Kernel on an in-memory database, with its dependencies replaced by typed fakes.

Plugins with a `db` get their real migrations. The harness finds the plugin folder from the running test file (the nearest `package.json` with a `petalbot` field); pass `{ dir }` when the test lives elsewhere.

UI code is tested with `renderPluginUi(ui)` from `@petalbot/testing/ui`. It renders a page, a
widget or an overlay component against a fake server, which the test drives with
`server.answer(rpc, result)`, `server.fail(rpc, code, message)`, `server.emit(event, payload)` and
`server.calls(rpc)`. Mark such test files with `// @vitest-environment happy-dom`.
