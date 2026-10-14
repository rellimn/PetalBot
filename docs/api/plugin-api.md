# PetalBot Plugin API (apiVersion 1)

This is the reference for plugin authors. The browser-facing APIs are generated:
`docs/api/openapi.json` (HTTP) and `docs/api/asyncapi.json` (WebSocket). The UI SDK
(components, tokens, client) is described in `docs/api/ui-sdk.md`.

Plugins import `@petalbot/sdk` (server and contracts) and `@petalbot/ui-sdk` (panel code), never `@petalbot/core`.

## Package and manifest

A plugin is a workspace package. `package.json` names its entries and its dependencies:

```jsonc
{
  "name": "@petalbot-plugin/alerts",
  "version": "1.0.0", // = the contract version
  "scripts": { "build": "vite build", "dev": "vite build --watch" },
  "petalbot": {
    "id": "alerts", // ^[a-z][a-z0-9-]*$, not "core" or "petalbot"
    "apiVersion": 1,
    "entries": {
      "server": "dist/server/server.js",
      "panel": "dist/panel/panel.js",
      "overlays": { "box": "dist/overlays/box/box.js" }, // one per overlay the contract declares
    },
    "dependencies": { "stream": "^1.0.0" }, // ranges match dependency contract versions
    "optionalDependencies": {},
  },
}
```

The ids listed under `dependencies` and `optionalDependencies` must match the contracts passed to `definePlugin`.

## Contracts: `defineContract`

```ts
export const alertsContract = defineContract({
  id: 'alerts',
  version: '1.0.0',
  settings: z.object({ volume: z.number().min(0).max(100).default(50) }),
  events: { shown: { schema: Alert, expose: ['panel', 'overlay'] } },
  hooks: { beforeShow: { input: Alert, failClosed: false } },
  rpc: {
    recent: { output: z.array(Alert), expose: { panel: 'mod', overlay: true } }, // no input

    clear: { output: Result(z.object({})), expose: { panel: 'owner' } },
  },
  providers: { sink: { show: { input: Alert, output: z.object({}) } } },
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

| Member      | Meaning                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`  | Settings schema, typed everywhere (server `ctx.settings`, custom settings forms, the test harness). Every field needs a default.                                                                                                                                              |
| `events`    | Fire-and-forget fan-out. Only the owner emits. `expose` makes an event reachable from the panel and/or overlays.                                                                                                                                                              |
| `hooks`     | Awaited, ordered pipeline that can modify or veto. Only the owner runs it; dependents tap it. Browsers never see hooks.                                                                                                                                                       |
| `rpc`       | Request/response, validated both ways. `expose.panel` is the minimum role; `expose.overlay: true` allows overlays.                                                                                                                                                            |
| `providers` | Interfaces dependents implement, keyed by a connection id. Every method is optional for implementers.                                                                                                                                                                         |
| `widgets`   | Every dashboard widget, with an optional per-instance `config`. Titles and components live in `definePanel`.                                                                                                                                                                  |
| `overlays`  | Each overlay's instance config and the exact events and RPCs it may use. Names must be exposed to `overlay` and come from the own contract or the overlay's `dependencies`. Wrong names are compile errors and also fail at runtime. Overlay names match `^[a-z][a-z0-9-]*$`. |

RPCs without `input` take none: `ctx.call('alerts.recent')`. Member names must be unique across
`events`, `hooks`, `rpc` and `providers`. `choice('<own rpc>')` makes a string field whose valid
values an own RPC lists at runtime (no input, output `Choices`, `expose.panel`). It's allowed in
top-level fields of `settings`, widget `config` and overlay `config`.

Versioning:

- Adding members or optional fields is a minor version.
- Removing or renaming anything, making a field required, changing a type, or adding a literal to a closed union (including `Result` failure reasons) is a major version.

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
fail with `PluginUnavailableError`. Each implementation gets `(input, { caller, client, who })`:

- `caller` is the calling plugin's id, or `'client'` for calls from a browser.
- `client` is then `{ kind: 'panel', user: { id, name, role } }` or `{ kind: 'overlay', instanceId }`.
- `who` is a display label: the panel user's name, `'overlay'`, or the calling plugin's id.

## `ctx` reference

| Member                                                       | Description                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`, `log`                                            | The plugin id and a pino child logger tagged with it.                                                                                                         |
| `on(event, handler)`                                         | Own and (optional) dependency events. Each subscription has its own FIFO queue.                                                                               |
| `emit(event, payload)`                                       | Own events only. Validated synchronously; an invalid payload throws `ValidationError`.                                                                        |
| `hook(name, handler, { priority })` / `runHook(name, input)` | Tap a hook / run an own hook. A handler returns the modified input, nothing, or `veto(reason)`.                                                               |
| `call(rpc, input?, { timeoutMs })`                           | Dependency RPCs (default timeout 5 s); RPCs without input take none. Throws `ValidationError`, `PluginUnavailableError`, `RpcTimeoutError`.                   |
| `provide(slot, key, impl)` / `providers(slot)`               | Implement a dependency's provider slot / resolve the providers of an own slot.                                                                                |
| `settings.get()` / `settings.onChange(fn)`                   | Validated settings; the panel edits them.                                                                                                                     |
| `kv.get/set/delete(key)`                                     | Declared keys only; values must survive JSON. `set(key, undefined)` deletes.                                                                                  |
| `kv.update(key, updater)`                                    | Atomic read-modify-write: a synchronous `updater(current)` runs in one transaction; `undefined` deletes. A throwing, async or invalid updater writes nothing. |
| `lock(key, fn)`                                              | Runs `fn` one at a time per key (FIFO); for async read-call-write sections. Waiting calls reject when the plugin stops.                                       |
| `secrets.get/set/delete(name)`                               | AES-256-GCM at rest; never sent to the panel.                                                                                                                 |
| `db`                                                         | Drizzle database for plugins that declare `db`. Tables must be prefixed `<pluginId>_`.                                                                        |
| `schedule.after/every/cron`                                  | Timers that never overlap and are disposed on stop.                                                                                                           |
| `http.route(method, path, handler, options)`                 | See below.                                                                                                                                                    |
| `isRunning(id)`                                              | For optional dependencies.                                                                                                                                    |
| `onDispose(fn)`                                              | Custom teardown. Everything registered through `ctx` is disposed automatically, in reverse order.                                                             |

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
- `dist/build.json` once everything is written. `vite build --watch` rewrites it after every
  successful rebuild, never after a failed one.

Browser bundles are built with the React Compiler. With `dev: true` in the config, the core
reloads a running plugin when its `dist/build.json` changes (and restarts it if it failed).
Otherwise use Admin › Plugins › Reload.

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

The client is described in `docs/api/ui-sdk.md` (Client). The counter's `src/client.ts` is the
worked example:

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

- **Client:** `createOverlayClient(contract, name, { queries, mutations })` has exactly the events
  and RPCs the declaration lists (anything else is a compile error), with the same handles as
  the panel client (`box.<id>.<member>.useQuery/useMutation/call/useEvent`). The server enforces
  the same list.
- **Config:** the component gets `config`, parsed with the declaration's schema in the browser,
  so defaults are applied. It re-renders when the owner changes the instance's config. A stored
  config that no longer fits the schema renders nothing (and logs to the console).
- **Page:** the overlay is mounted on a transparent full-viewport page. Draw your own
  background, if any; use `--pb-*` tokens and CSS Modules as in the panel. While the plugin is
  stopped the page is empty; after a reload with new code it reloads itself.
- **Instances:** owners create instances in Admin › Overlays: each has a name, its own config
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

## Errors and results

- Infrastructure failures throw `PetalBotError` subclasses: `ValidationError`, `PluginUnavailableError`, `RpcTimeoutError`, `AccessError`, `ContractVersionError`.
- Domain outcomes (anything a platform can refuse) are returned as `Result` values: `ok(value)` or `fail(reason, message)`, with the closed reason set in `FAILURE_REASONS`.
- Browsers see `{ code, message }` only. Messages of `PetalBotError`s are passed through; any other error becomes `internal`.

## Defaults and limits

| What                  | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| `setup` timeout       | 10 s                                                                                   |
| RPC timeout           | 5 s                                                                                    |
| Hook handler timeout  | 2 s (fail-open unless `failClosed`)                                                    |
| Event causation depth | 16                                                                                     |
| Degraded              | 10 failures within 60 s, or any uncaught error                                         |
| WebSocket             | 64 KiB frames, 32 concurrent RPCs per socket                                           |
| Browser bundles       | ≤ 1000 files per bundle folder, ≤ 20 MiB per plugin; served only while the plugin runs |
| Log ring              | last 2000 entries at the configured level                                              |
| Dashboard             | 1–3 columns, ≤ 20 widgets per column, ≤ 20 presets per user                            |

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

`createTestHarness` (from `@petalbot/testing`) runs the plugin in a real Kernel on an in-memory database, with its dependencies replaced by typed fakes.

Plugins with a `db` get their real migrations. The harness finds the plugin folder from the running test file (the nearest `package.json` with a `petalbot` field); pass `{ dir }` when the test lives elsewhere.

UI code is tested with `renderPluginUi(ui)` from `@petalbot/testing/ui`. It renders a page, a
widget or an overlay component against a fake server, which the test drives with
`server.answer(rpc, result)`, `server.fail(rpc, code, message)`, `server.emit(event, payload)` and
`server.calls(rpc)`. Mark such test files with `// @vitest-environment happy-dom`.
