# Writing a PetalBot plugin

Everything in PetalBot is a plugin: chat, alerts, commands, the counter. A plugin is trusted
TypeScript code that runs inside the core's Node process. It can add server logic (storage, RPCs,
events, timers, HTTP routes), panel pages and dashboard widgets, and OBS overlays. Plugins talk
to each other only through typed **contracts**, so every name and payload autocompletes.

This guide walks through a plugin from start to finish, then lists the rules that bite, a
"when to use what" section, how platforms plug in and a glossary. The API references hold the details:
[docs/api/plugin-api.md](api/plugin-api.md) (contracts, server, build, testing) and
[docs/api/ui-sdk.md](api/ui-sdk.md) (client, components, tokens). The counter
([plugins/counter](../plugins/counter/README.md)) is the full worked example; most excerpts below
come from it.

## 1. Before you start

A plugin is a folder in `plugins/`. This is what `pnpm create-plugin` writes:

```
plugins/my-plugin/
  package.json          name, version (= contract version), petalbot: { id, apiVersion }
  tsconfig.json         extends @petalbot/tooling/tsconfig/react.json
  vite.config.ts        petalbotPlugin(): builds everything into dist/
  vitest.config.ts      the plugin's test project
  src/contract.ts       the contract                                   runs everywhere
  src/server.ts         definePlugin: storage, RPCs, events            Node (the core)
  src/db/schema.ts      Drizzle table (with --db)                      Node
  drizzle/              generated migrations (with --db)               Node
  src/client.ts         createPluginClient: typed hooks                panel
  src/panel.tsx         definePanel: pages and widgets                 panel
  src/overlays/<n>.tsx  defineOverlay: one OBS overlay each            overlay host
  test/server.test.ts   harness tests
  test/panel.test.tsx   UI tests
```

The build writes `dist/server/server.js`, `dist/panel/`, `dist/overlays/<name>/` and
`dist/build.json`, which tells the core what was built.

Commands (run from the repository root unless noted). In this repository pnpm runs as
`npx -y pnpm@12.10.1 …`; the guide writes `pnpm …` for short.

| Command                            | What it does                                                                |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `pnpm create-plugin <id> [flags]`  | Scaffolds, installs and builds a new plugin (section 2).                    |
| `pnpm dev`                         | Core, panel and overlay host with live reload; watches every plugin.        |
| `pnpm build`                       | Builds the panel, the overlay host and every plugin.                        |
| `pnpm test`                        | All tests. `node_modules/.bin/vitest run --project <id>` runs one plugin's. |
| `pnpm check`                       | Typecheck, lint, format check and tests: run it before committing.          |
| `pnpm db:generate --name <change>` | In a plugin folder with `--db`: writes a migration for schema changes.      |

## 2. Create a plugin

```sh
pnpm create-plugin my-plugin                   # KV storage, a page and a widget
pnpm create-plugin my-plugin --db              # a Drizzle table instead of KV
pnpm create-plugin my-plugin --overlay banner  # plus src/overlays/banner.tsx (repeatable)
pnpm create-plugin my-plugin --no-panel        # server only
```

The id must match `^[a-z][a-z0-9-]*$` and must not be `core`, `petalbot` or an id another plugin
uses. The command writes `plugins/<id>/`, runs `pnpm install`, generates the first migration
(`--db`) and builds the plugin once.

The scaffold is a tiny working plugin with every basic pattern:

- one setting, `step`, with a generated settings form;
- a stored total (KV key `presses`, or the table `<id>_presses` with `--db`);
- a read RPC `status` (`kind: 'query'`) and a write RPC `press` that adds `step` and announces it with the event
  `pressed`;
- a page and a dashboard widget that stay live through the client definition;
- with `--overlay`, an overlay that shows the total;
- server tests (including a concurrency test) and a widget test.

**The dev loop.** With `pnpm dev` running, a new plugin is picked up within seconds: the dev
script starts its build watcher, the core discovers it and, because this is dev, enables it.
After that, every save rebuilds the plugin and the core reloads it; the panel swaps in the new
bundle without a page reload (UI state resets, see section 10). Try it: change the `Press`
label in `src/panel.tsx`, save, and watch the page.

Adding a new file in `src/overlays/` needs a restart of `pnpm dev`, because a build watcher fixes
its entries when it starts.

## 3. The contract

`src/contract.ts` describes everything other code may know about the plugin: its events, RPCs,
hooks, providers, settings, widgets and overlays. The server, the panel, the overlay host and
other plugins all import it, so it may import only `zod` and `@petalbot/sdk`, never server code.

```ts
// plugins/counter/src/contract.ts
export const counterContract = defineContract({
  id: 'counter',
  // Must equal the package.json version. A breaking change to this contract is a major bump.
  version: '3.0.0',
  // ...
  rpc: {
    // `kind: 'query'` marks a read: clients get useQuery for it and may repeat it freely (on
    // mount, on focus, after events). Everything without a kind is a mutation (useMutation).
    // RPCs without `input` take none: callers write ctx.call('counter.list').
    list: { kind: 'query', output: z.array(Counter), expose: { panel: 'mod' } },
    // The values behind choice('counter.options') below: [{ value: id, label: name }].
    // choice() only accepts queries.
    options: { kind: 'query', output: Choices, expose: { panel: 'mod' } },
    // null rather than an error: a widget or overlay may point at a counter deleted since.
    get: {
      kind: 'query',
      input: CounterRef,
      output: Counter.nullable(),
      expose: { panel: 'mod', overlay: true },
    },
    // Result: "not found" is an expected outcome the caller handles, not a crash.
    increment: {
      input: CounterRef,
      output: Result(z.object({ counter: Counter })),
      expose: { panel: 'mod' },
    },
    // …
  },

  widgets: {
    // One dashboard widget per counter: the user picks which one when placing it.
    value: {
      config: z.object({
        counter: choice('counter.options').describe('Which counter this widget shows'),
      }),
    },
  },
  // …
});
```

- **Id and version.** The id is the plugin id. The version equals the package version and
  follows semver: adding members or optional fields is minor; removing or renaming anything,
  making a field required or changing a type is major.
- **Qualified names.** Members are always named with their contract: `counter.changed`,
  `counter.get`. Member names are unique across events, hooks, RPCs and providers.
- **Events** (`schema`, `expose: ['panel', 'overlay']`) are fire-and-forget announcements. Only
  the owner emits them.
- **RPCs** (`kind` optional, `input` optional, `output`,
  `expose: { panel: 'mod' | 'owner', overlay?: true }`) are request and response, validated
  both ways. The server checks the role on every call. `kind: 'query'` marks an RPC that only
  reads and is safe to repeat; clients call it on mount, on focus, on retry and after events.
  Without `kind` an RPC is a mutation: clients only call it when the user acts.
- **Hooks** are an awaited pipeline other plugins tap to change or veto something; **providers**
  are interfaces other plugins implement, keyed by a connection (sections 11 and 12).
- **Settings** are a zod object; the panel generates their form. Every field needs a default.
- **Widgets** list the dashboard widgets, each with an optional per-instance `config`.
- **Overlays** list each overlay's instance `config` and exactly the events and RPCs it may use.
- **`choice('<plugin>.<rpc>')`** is a string field whose valid values an own query RPC lists at
  runtime (`kind: 'query'`, no input, output `Choices`: `[{ value, label }]`). Forms render it
  as a select.
- **`Result(z.object({…}))`** is an RPC output that is either `{ ok: true, … }` or
  `{ ok: false, reason, message }`, for outcomes the caller must handle.

Keep the contract's data shapes separate from storage: the counter's `Counter` schema is not its
Drizzle table, so the table can change without breaking anyone who depends on the contract.

## 4. The server

`src/server.ts` default-exports `definePlugin(contract, { kv?, db?, dependencies?, setup })`.
`setup(ctx)` runs on every start (enable, reload) and returns the RPC implementations; they
become callable once `setup` has finished. TypeScript checks that every RPC is implemented.
Each implementation gets `(input, { caller, client, who })`; `who` is a display label (the
panel user's name, `'overlay'`, or the calling plugin's id).

```ts
// plugins/counter/src/server.ts
        // `who` is a label for the caller: the panel user's name, 'overlay', or a plugin id.
        increment: ({ counter }, { who }) => {
          // One UPDATE … RETURNING statement reads and writes the value. Nothing can run in
          // between, unlike "read the value, await something, write value + step", which loses
          // clicks when two arrive at once.
          // Drizzle types `.get()` as always finding a row, but it's undefined when none matched.
          const row = ctx.db
            .update(counters)
            .set({ value: sql`${counters.value} + ${ctx.settings.get().step}` })
            .where(eq(counters.id, counter))
            .returning()
            .get() as Row | undefined;
          return row ? changed(row, who) : notFound(counter);
        },
```

The `ctx` you get in `setup`:

| Member                                | Use                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ctx.emit(event, payload)`            | Announce something. Emit **after** the write, so handlers see the new state.                               |
| `ctx.on(event, handler)`              | React to own and dependency events (each subscription has its own queue).                                  |
| `ctx.call(rpc, input?)`               | Call a dependency's RPC (5 s timeout).                                                                     |
| `ctx.hook` / `ctx.runHook`            | Tap a dependency's hook / run an own hook.                                                                 |
| `ctx.settings.get()` / `onChange(fn)` | The current, validated settings.                                                                           |
| `ctx.kv.get/set/delete/update`        | Declared keys (`kv: { name: schema }`); values must survive JSON. `update` is an atomic read-modify-write. |
| `ctx.lock(key, fn)`                   | Run `fn` one at a time per key, for read–await–write sections.                                             |
| `ctx.db`                              | The plugin's Drizzle database (`db: { schema }`).                                                          |
| `ctx.secrets`                         | Declared credentials (contract `secrets`), encrypted; user-settable ones are entered on the settings page. |
| `ctx.http.url(path)`                  | Absolute URL of an own route (OAuth redirect URLs).                                                        |
| `ctx.schedule.after/every/cron`       | Timers, disposed on stop.                                                                                  |
| `ctx.http.route(…)`                   | HTTP routes under `/api/p/<id>/` (webhooks, OAuth callbacks).                                              |
| `ctx.onDispose(fn)`                   | Custom teardown. Everything registered through `ctx` is cleaned up automatically.                          |
| `ctx.log`                             | A logger tagged with the plugin.                                                                           |

The scaffold's KV variant shows the atomic update:

```ts
// src/server.ts as `pnpm create-plugin my-plugin` writes it
        press: async (_input, { who }) => {
          // kv.update reads and writes in one transaction, so two presses at once both count.
          const presses =
            (await ctx.kv.update(
              'presses',
              (current) => (current ?? 0) + ctx.settings.get().step,
            )) ?? 0;
          // Emit after the write: whoever reacts to the event already sees the new total.
          ctx.emit('my-plugin.pressed', { presses, by: who });
          return { presses };
        },
```

**The plugin database.** With `db: { schema }` the plugin gets its own Drizzle database. Tables
must be named `<id>_…` (the core refuses others). Define them in `src/db/schema.ts`, then run
`pnpm db:generate --name <change>` in the plugin folder: drizzle-kit writes a migration into
`drizzle/`, and the core applies it when the plugin starts. Never edit a migration that was
applied; add a new one. better-sqlite3 is synchronous, so a `ctx.db.transaction((tx) => …)`
without `await` inside runs as one unit:

```ts
// plugins/counter/src/server.ts
        create: ({ name }) => {
          // The name check and the insert run in one transaction, so two creates with the same
          // name can't both pass the check. A duplicate is the caller's mistake, so it throws a
          // ValidationError (the panel shows it on the name field) instead of returning a Result.
          const row = ctx.db.transaction((tx) => {
            const taken = tx
              .select({ id: counters.id })
              .from(counters)
              .where(eq(counters.name, name))
              .get();
            if (taken) {
              throw new ValidationError('counter name', [
                // …
              ]);
            }
            // …
          });
          ctx.emit('counter.listChanged', {});
          return toCounter(row);
        },
```

**Errors.** Throw `ValidationError` for the caller's mistakes (the panel shows its issues on the
form fields). Return `fail(reason, message)` from a `Result` RPC for outcomes the caller must
handle (`not-found`, `forbidden`, `rate-limited`, …). Anything else that throws becomes an
`internal` error for browsers and counts toward the plugin's health.

## 5. The client

`src/client.ts` creates the panel client once, at module scope:

```ts
// plugins/counter/src/client.ts
export const api = createPluginClient(counterContract, {
  queries: {
    // `update` computes the new list from the event: no round trip per click. It must return
    // a new array (never mutate), because the cache and the React Compiler compare by reference.
    'counter.list': {
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (list, event) =>
          list.map((item) =>
            item.id === event.payload.counter ? { ...item, value: event.payload.value } : item,
          ),
      },
    },
    // …
  },
  mutations: {
    // Events already keep every view live (in every tab), so a click needs no extra refetch.
    // Without `invalidates`, a mutation refetches all of the counter's queries in this tab.
    'counter.increment': { invalidates: [] },
    'counter.reset': { invalidates: [] },
  },
});
```

- **Handles.** `api.<contract id>.<member>` mirrors the qualified name: `api.counter.list`. Ids
  with dashes need brackets: `api['my-plugin'].status`. Pass dependency contracts in
  `dependencies` to get their namespaces too.
- **Queries** are the RPCs the contract marks `kind: 'query'`: `useQuery(input?, { enabled })`.
  Everything else is a mutation: `useMutation({ success?, error? })` with `mutate(input?)`.
  The client can't change that, so no client can turn a write into a query. Every RPC has
  `call(input?)`; every event has `useEvent(handler)`.
- **Freshness is declared once.** `queries` lists only queries that need live options; the
  others are plain queries. `refreshOn: [events]` refetches the query when an event
  arrives. `update: { event: (data, event, input) => next }` computes the new data from the
  payload without a round trip; `input` is the cached entry's input, so return `data` unchanged
  when the event is about something else.
- **Invalidation.** After a successful mutation, the client refetches its own contract's
  queries in this tab. `invalidates: [...]` replaces that list; `[]` turns it off when events
  already keep things live. Other tabs, users and overlays only learn about changes through
  events.
- **Toasts.** `useMutation({ error: 'Could not count' })` shows a toast on failure; a failed
  `Result` counts as a failure.

## 6. The panel

`src/panel.tsx` default-exports `definePanel(contract, { pages, widgets, settings? })`:

```tsx
// plugins/counter/src/panel.tsx
function CounterWidget({ config }: WidgetProps<typeof counterContract, 'value'>) {
  const counter = api.counter.get.useQuery({ counter: config.counter });
  const increment = api.counter.increment.useMutation({ error: 'Could not count' });
  if (counter.isPending) return <Spinner label="Loading the counter" />;
  // null, not an error: the counter was deleted after this widget was placed.
  if (counter.data === null || counter.data === undefined) {
    return <p className={styles.muted}>This counter was deleted</p>;
  }
  // …
}

export default definePanel(counterContract, {
  pages: [
    { path: 'counter', title: 'Counters', icon: Hash, minRole: 'mod', component: CountersPage },
  ],
  // Keys must match the contract's widgets; the config type comes from there.
  widgets: {
    value: {
      title: 'Counter',
      description: 'One counter with a +1 button',
      minRole: 'mod',
      component: CounterWidget,
    },
  },
  // No custom settings form: the generated one handles `step` well enough.
});
```

- **Pages** live under `/p/<id>/<path>` and appear in the sidebar. `minRole` is `'owner'` by
  default; the server still checks every RPC.
- **Widgets** are keyed like the contract's `widgets`. Users can place the same widget several
  times; each instance has its own `config` and `instanceId`. A widget whose config has a
  required field opens a configure dialog when it's added, and a stored config that no longer
  fits the schema shows "Needs configuration". Titles get a suffix from the first `choice()`
  field ("Counter · Deaths").
- **Settings** get a generated form. Write a custom `settings` component
  (`SettingsFormProps<typeof contract>`: `values`, `schema`, `save(patch)`) only when the
  generated one can't express what you need; the counter deliberately has none.
- **Styling.** Use `@petalbot/ui-sdk` components (`Button`, `Card`, `Field`, `Input`, …) and CSS
  Modules with the `--pb-*` tokens, so the plugin follows every color scheme and density.

## 7. Overlays

An overlay is a page OBS shows as a browser source. Declare it in the contract, then write
`src/overlays/<name>.tsx`:

```tsx
// plugins/counter/src/overlays/display.tsx
const display = createOverlayClient(counterContract, 'display', {
  queries: {
    'counter.get': {
      // A removed counter answers null after this refetch, and the overlay disappears.
      refreshOn: ['counter.listChanged'],
      update: {
        'counter.changed': (data, event, input) =>
          data !== null && event.payload.counter === input.counter
            ? { ...data, value: event.payload.value }
            : data,
      },
    },
  },
});

function Display({ config }: OverlayProps<OverlayConfig<typeof counterContract, 'display'>>) {
  const current = display.counter.get.useQuery({ counter: config.counter });
  // Nothing while loading, and nothing for a deleted counter: OBS shows a transparent page.
  if (!current.data) return null;
  // …
}

export default defineOverlay(counterContract, 'display', { component: Display });
```

- The overlay client has exactly the events and RPCs the contract's overlay declaration lists;
  the server enforces the same list.
- Render nothing while loading: the page is transparent, so OBS shows nothing.
- Overlay bundles are served without a login (OBS has no session). Never put secrets in them.
- Owners create instances in Admin > Overlays. Each instance has its own config and its own OBS
  URL with a token; the panel shows a live preview.

## 8. Testing

Server code is tested with `createTestHarness` from `@petalbot/testing`. It runs the plugin in a
real core on an in-memory database, with the real migrations:

```ts
// plugins/counter/test/server.test.ts
it('stays exact under concurrent increments', async () => {
  // Each increment is one UPDATE … RETURNING statement, so none can overwrite another.
  const harness = await start();
  const { id } = await harness.call('counter.create', { name: 'Clicks' });
  await Promise.all(
    Array.from({ length: 100 }, () => harness.call('counter.increment', { counter: id })),
  );
  await expect(harness.call('counter.get', { counter: id })).resolves.toMatchObject({
    value: 100,
  });
  await harness.stop();
});
```

The harness has `call(rpc, input?)`, `emit(event, payload)` (as a dependency would),
`events` (everything emitted), `idle()` (wait for queued handlers), `updateSettings(patch)` and
`stop()`. Options: `settings` (typed from the contract) and `fakes` for dependencies' RPCs.

UI code is tested with `renderPluginUi` from `@petalbot/testing/ui`, against a fake server that
the test drives. Mark such files with `// @vitest-environment happy-dom`:

```tsx
// plugins/counter/test/panel.test.tsx
const { server } = renderPluginUi(<CounterWidget config={{ counter: 'a' }} instanceId="w1" />);
await waitFor(() => {
  expect(server.calls('counter.get')).toMatchObject([{ input: { counter: 'a' } }]);
});
act(() => {
  server.answer('counter.get', deaths);
});
expect(await screen.findByText('3')).toBeTruthy();
```

`server.answer(rpc, result)` and `server.fail(rpc, code, message)` answer the latest call of that RPC;
`server.emit(event, payload)` sends an event; `server.calls(rpc)` lists the calls.

## 9. Iterate and ship

- **Develop** in `pnpm dev`: saves rebuild and reload the plugin; the panel swaps in the new
  bundle; a plugin that failed to start is retried after the next successful build.
- **Check** with `pnpm check` before committing.
- **Production** (`pnpm build`, then `pnpm start`): new plugins start **disabled**; the owner
  enables them in Admin > Plugins. After rebuilding a plugin, use Admin > Plugins > Reload.
- **Not built.** A plugin folder without `dist/build.json` (or with one from an older tooling)
  is listed under Admin > Plugins as "Not built". Run `pnpm build` in it, or start `pnpm dev`.
- **Dependencies between plugins.** List them in `package.json` (`petalbot.dependencies`,
  `optionalDependencies`, with semver ranges of the contract versions) and pass the contracts to
  `definePlugin({ dependencies: [...] })`. Both lists must match. Enabling a plugin offers to
  enable its dependencies.

## 10. Watch out for

- **Clients live at module scope.** The React Compiler needs the hooks behind `api` to be the
  same functions on every render; never create a client inside a component.
- **Query data is immutable, so `update` returns new objects.** The cache and the compiler
  compare by reference; a mutated object never re-renders.
- **Events have no replay, so displayed state comes from a query.** A component that mounts
  later missed every earlier event; use `useEvent` only for things that happen (sounds, alerts).
- **Emit after the write.** Handlers and refetches triggered by the event must see the new state.
- **Use `kv.update`/`lock` for concurrent writes; a hung `lock` blocks its key.** "Read, await,
  write" loses updates when two calls overlap. Keep the code inside a lock short and give
  awaited calls timeouts.
- **KV values must survive JSON.** No `Date`, `Map`, `undefined` fields or class instances.
- **Use the SDK codecs for dates and bigints in exposed data.** `codecs.isoDate()` and
  `codecs.bigintString()`; plain `z.date()` can't travel to the browser.
- **Timers go through `ctx.schedule`, cleanup through `onDispose`.** A bare `setInterval`
  survives a reload and keeps running with stale code.
- **UI code never imports server code.** The contract, the client and `@petalbot/ui-sdk` only;
  ESLint enforces it.
- **A reload resets UI state.** Each rebuild remounts the plugin's components and stores.
- **Overlay bundles are public.** Anyone with the URL path can download them.
- **No Tailwind: use ui-sdk components, CSS Modules and `--pb-*` tokens.** Class names from a
  runtime-loaded bundle are missing from the panel's CSS.
- **Settings need defaults.** A fresh install starts without stored settings.
- **Contract changes follow semver.** Dependents declare version ranges; a breaking change
  without a major bump breaks them at runtime.
- **New overlay files need a `pnpm dev` restart.** The watcher fixes its entries when it starts.
- **Never edit applied migrations.** Add a new one with `pnpm db:generate --name <change>`.
- **Table names need the `<id>_` prefix.** The core refuses other tables.

## 11. When to use what

**Event vs. hook vs. RPC vs. provider**

| Use …      | when                                                                        | Example                                      |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| an event   | something happened and anyone may react; the emitter doesn't wait           | `counter.changed`, `stream.follow`           |
| a hook     | other plugins may change or veto something before it happens (awaited)      | a moderation plugin vetoing a chat message   |
| an RPC     | a caller needs an answer or asks the owner to do something                  | `counter.increment`, `counter.list`          |
| a provider | the owner defines an interface that other plugins implement, per connection | `chat` platform slot implemented by `twitch` |

**`refreshOn` vs. `update` vs. invalidation**

| Use …                      | when                                                                   | Example                                      |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `refreshOn`                | an event means "this changed", but its payload doesn't hold the answer | the counter list on `counter.listChanged`    |
| `update`                   | the payload holds the new value; busy streams                          | `counter.get` patched from `counter.changed` |
| invalidation (the default) | this tab changed something no event announces                          | a settings-like mutation without an event    |
| `invalidates: []`          | events already keep every view live                                    | `counter.increment`                          |

**`useQuery` vs. `useEvent`**

| Use …      | when                                             | Example                                 |
| ---------- | ------------------------------------------------ | --------------------------------------- |
| `useQuery` | showing what _is_: anything rendered as state    | a counter's value, a list               |
| `useEvent` | reacting to what _happened_, once per occurrence | a sound on a follow, an alert animation |

Effects on query data are no replacement for `useEvent`: they fire on loads and refetches, miss
repeated values and lose the cause.

**Where data lives**

| Use …          | for                                                 | Example                            |
| -------------- | --------------------------------------------------- | ---------------------------------- |
| settings       | plugin-wide options the owner edits                 | the counter's `step`               |
| widget config  | per placed widget                                   | which counter a widget shows       |
| overlay config | per overlay instance (per OBS scene)                | the counter and size of an overlay |
| KV             | a few values the plugin owns, small and JSON-shaped | the scaffold's total               |
| the plugin DB  | records, lists, anything you query or that grows    | the counters                       |
| secrets        | tokens and passwords                                | a Twitch OAuth token               |

**`kv.update` vs. `lock` vs. a DB transaction**

| Use …             | when                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `kv.update`       | the new KV value depends only on the old one                       |
| one SQL statement | the same for a DB row (`UPDATE … SET value = value + ? RETURNING`) |
| a DB transaction  | several statements that must happen together, with no `await`      |
| `lock`            | an `await` must sit between reading and writing (e.g. an API call) |

**Client store vs. query vs. component state**

| Use …                          | for                                                                   |
| ------------------------------ | --------------------------------------------------------------------- |
| a query                        | data the server owns, including buffers of recent events (via an RPC) |
| a client store (`createStore`) | UI state shared between components: drafts, filters, a selection      |
| component state                | UI state of one component                                             |

**Page vs. widget vs. overlay**

| Use …      | for                                                   | Example             |
| ---------- | ----------------------------------------------------- | ------------------- |
| a page     | managing things: lists, forms, history                | the Counters page   |
| a widget   | a glance or one action on the dashboard, per instance | one counter with +1 |
| an overlay | what viewers see on stream                            | a counter in OBS    |

**`Result` vs. throwing**

| Use …                    | when                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `Result` (`ok` / `fail`) | an expected outcome the caller handles: not found, forbidden, rate-limited |
| throw `ValidationError`  | the caller sent something invalid (shown on the form field)                |
| let it throw             | a bug or an outage; the caller sees `internal`                             |

## 12. Platforms and providers

Plugins never talk to Twitch, YouTube or Kick themselves. Two **domain** plugins describe what
platforms offer, platform-neutrally:

- **`chat`** ([plugins/chat](../plugins/chat/README.md)): messages in (`chat.message`), messages
  out (`chat.send`, `chat.reply`, `chat.broadcast`), moderation (`chat.delete`, `chat.timeout`),
  the `chat.beforeSend` hook and the Chat widget.
- **`stream`** ([plugins/stream](../plugins/stream/README.md)): community events
  (`stream.follow`, `stream.subscription`, `stream.giftSubscription`, `stream.raid`,
  `stream.support`, `stream.online`, `stream.offline`) and the Activity widget.

**Platform plugins** (`twitch`, later others) implement the domains through **providers**, once per
**connection** (`twitch:roman`). A consumer written against `chat` works on every platform,
including ones added later.

### Using the domains

Depend on the domain like on any plugin (section 9): in `package.json`, list it under
`petalbot.dependencies` (`"chat": "^1.0.0"`) and add the package (`"@petalbot-plugin/chat":
"workspace:*"`), then import its contract from `@petalbot-plugin/chat/contract`:

```ts
import { chatContract } from '@petalbot-plugin/chat/contract';

export default definePlugin(greeterContract, {
  dependencies: [chatContract],
  setup(ctx) {
    ctx.on('chat.message', async ({ payload: message }) => {
      // The bot's own messages arrive here too: never react to them.
      if (message.fromBot || message.text !== '!hello') return;
      const result = await ctx.call('chat.reply', { to: message, text: 'Hi!' });
      if (!result.ok) ctx.log.warn('Could not greet', { reason: result.reason });
    });
  },
});
```

- **Targets.** `{ connection: 'twitch:roman' }`, or `{ platform: 'twitch' }` for that platform's
  default connection (or its only one). Replies go where the message came from.
- **Results, not exceptions.** Every operation answers `{ ok: true, ... }` or
  `{ ok: false, reason, message }`: `not-found` (no such connection), `unsupported` (the platform
  can't do it), `forbidden` (a `chat.beforeSend` tap vetoed, or the platform refused),
  `rate-limited` (not sent: too many messages) or `platform-error` (the platform failed).
- **Replies.** `chat.reply` answers natively where the platform can (`delivery: 'native'`), else
  the platform mentions the author in its own syntax (`delivery: 'mention'`).
- **`chat.broadcast`** sends to every connection at once (or those of `platforms` /
  `connections`) and returns one result per connection; one failure blocks no other.
- **`chat.beforeSend`** lets a plugin rewrite or veto every outgoing message (send, reply,
  broadcast), e.g. a filter: `ctx.hook('chat.beforeSend', (input, { veto }) => ...)`.
  `input.caller` says who sends: a plugin id, or `client` for the panel.
- **`chat.connections()`** lists the connections and what each can do (`capabilities`).
- **Stream events** carry `source` like chat messages; an event a platform doesn't have is never
  emitted for it.

### Writing a platform plugin

A platform plugin lists `chat` and/or `stream` as **required** dependencies (an optional one is
not restarted with the domain, so its connections would be lost for good when the domain
reloads) and does three things per connection:

```ts
const id = `twitch:${login}`; // <platform>:<channel>
// 1. Provide: the domain calls these. Every method is optional.
ctx.provide('chat.platform', id, {
  send: async ({ text }) => limiter.schedule(() => api.send(text)).then(toResult),
});
// 2. Announce the connection; only the plugin providing `id` may.
await ctx.call('chat.registerConnection', {
  id,
  platform: 'twitch',
  channel: login,
  displayName,
  isDefault: true,
});
// 3. Feed inbound messages; the domain emits chat.message.
await ctx.call('chat.ingest', { id: msg.id, source: { platform: 'twitch', connection: id }, ... });
```

- **Providers answer with a `Result`.** Map the platform's answers: a dropped or refused message
  is `rate-limited` or `forbidden`, a 5xx is `platform-error`. A provider that throws becomes a
  `platform-error` too, and is logged as a bug.
- **Rate limiting lives in the provider** (`createRateLimiter`, one per connection), not in the
  domain. `rate-limited` always means "not sent".
- **Own the reply fallback.** Without native replies, mention the author in the platform's own
  syntax and answer `delivery: 'mention'`; the domain never rewrites text.
- **Set `fromBot`** on messages written by the bot's account. `chat.ingest` drops a message id
  it already has for that connection, so redelivered messages are harmless.
- **Connections end with their provider.** Disposing the provider, or stopping the plugin,
  removes the connection; after providing it again, register it again. Re-registering replaces
  the info (e.g. a new `isDefault`).
- **`stream` works the same way:** provide `stream.platform` (no methods yet, it ties the
  connection to your plugin), call `stream.registerConnection` (with `live`/`since` if the stream
  is already running, also when registering again) and `stream.ingest({ type: 'follow', source, user })`.

### Owning a provider slot

A domain author resolves its slot with `ctx.providers('chat.platform')`: `keys()`, `get(key)`
(a handle whose `call` validates input and output) and `onChange(fn)`, which reports every
provider that comes or goes after subscribing (no replay: `keys()` lists the current ones). Check `handle.pluginId` against the RPC's `caller` before accepting
anything on a connection's behalf, and check `handle.has(method)` before running hooks for an
operation the provider can't do.

### Testing

- **Consumers** fake the domain's RPCs and emit its events:
  `createTestHarness(greeter, { fakes: { chat: { rpc: { reply: async () => ({ ok: true, messageId: 'r1', delivery: 'native' }) } } } })`,
  then `harness.emit('chat.message', message)`.
- **Platform plugins** fake `registerConnection` and `ingest` to record what arrives, and call
  their own provider the way the domain would: `harness.provider('chat.platform', 'twitch:roman')`.
- **Domains** get fake providers: `providers: { 'chat.platform': { 'twitch:test': fake } }`, and
  `harness.addProvider(...)` mid-test. They come from the same harness plugin as `harness.call`,
  so the test may register those connections and ingest for them (see `plugins/chat/test`).

## 13. Glossary

- **Caller:** who called an RPC: a plugin id, or `'client'` for the panel and overlays. RPC
  implementations get it with `client` and `who` (section 4).
- **Choice:** a string field (`choice('<plugin>.<rpc>')`) whose valid values an RPC lists at
  runtime; forms show it as a select (section 3).
- **Connection:** one platform account the bot is attached to, e.g. `twitch:roman`. Providers
  are keyed by connection (section 12).
- **Contract:** the isomorphic description of a plugin's events, RPCs, hooks, providers,
  settings, widgets and overlays (section 3).
- **`ctx`:** the plugin context `setup` receives: events, RPCs, storage, timers (section 4).
- **Domain:** a platform-neutral plugin such as `chat` or `stream` that defines what platforms
  offer; platform plugins implement it through providers (section 12).
- **Event:** a fire-and-forget announcement with a validated payload (section 3).
- **Exposure:** which members the panel (with a minimum role) and overlays may use: `expose` on
  events and RPCs (section 3).
- **Hook:** an awaited pipeline the owner runs and other plugins tap to change or veto its input.
- **KV:** per-plugin key-value storage for declared, JSON-shaped values (section 4).
- **Live query:** a query kept fresh by events through `refreshOn` or `update` (section 5).
- **Member:** one event, RPC, hook or provider slot of a contract.
- **Mutation:** an RPC without `kind: 'query'`; clients get `useMutation` for it (sections 3
  and 5).
- **Overlay / overlay instance:** an OBS page a plugin defines / one configured copy of it with
  its own URL and token (section 7).
- **Plugin DB:** the plugin's own Drizzle/SQLite database with `<id>_` tables (section 4).
- **Preset:** a user's named dashboard layout, holding widget instances.
- **Provider and slot:** a slot is an interface a contract defines; a provider is another
  plugin's implementation of it for one connection (section 12).
- **Qualified name:** `<contract id>.<member>`, e.g. `counter.changed`; the only way names are
  written.
- **Query:** an RPC with `kind: 'query'`: it only reads, and clients get `useQuery` for it,
  cached per input (sections 3 and 5).
- **`Result`:** an RPC output that is `{ ok: true, … }` or `{ ok: false, reason, message }`
  (section 4).
- **RPC:** a validated request-and-response call (section 3).
- **Secrets:** encrypted per-plugin values such as tokens; never sent to the panel. Declared in the contract; the owner enters user-settable ones in the Secrets card.
- **Settings:** plugin-wide options from the contract's schema, edited in the panel (section 6).
- **Target:** where a platform operation goes: `{ platform }` (its default connection) or
  `{ connection }` (section 12).
- **Veto:** a hook handler's answer that stops the action: `(input, { veto }) => veto(reason)`.
- **Widget / widget instance:** a dashboard tile a plugin defines / one placed copy of it with
  its own config (section 6).
