# Counter: the example plugin

Several named counters, stored in the plugin's own Drizzle database: a Counters page to create,
count, reset and remove them, a dashboard widget that shows one counter, and an OBS overlay.

The counter is small on purpose and meant to be **read**. Its comments explain why each pattern
is there and are denser than elsewhere in the codebase. For the concepts behind them, read
[docs/plugin-guide.md](../../docs/plugin-guide.md) alongside.

## What it demonstrates

| Pattern                                                          | Where                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| A contract shape separate from the table, mapped in one function | `Counter` in `src/contract.ts`, `toCounter` in `src/server.ts` |
| An atomic update: one `UPDATE … RETURNING` statement             | `increment` in `src/server.ts`                                 |
| A transaction that throws a `ValidationError` on one field       | `create` in `src/server.ts`                                    |
| `Result` with `not-found` for expected failures                  | `increment`, `reset`, `remove`                                 |
| `null` for things deleted since                                  | `get`, the widget and the overlay                              |
| Emit after the write                                             | `changed()` in `src/server.ts`                                 |
| A widget configured with `choice('counter.options')`             | `widgets` in `src/contract.ts`, `CounterWidget`                |
| A live list through `refreshOn` + `update`                       | `src/client.ts`                                                |
| Mutations that don't refetch (`invalidates: []`)                 | `src/client.ts`                                                |
| An overlay client limited to its declaration                     | `src/overlays/display.tsx`                                     |
| Harness, concurrency, settings, UI and overlay tests             | `test/`                                                        |
| No custom settings form: the generated one is enough             | `src/panel.tsx`                                                |

## Reading order

1. [src/contract.ts](src/contract.ts): what other code may know: events, RPCs, settings, the
   widget and the overlay.
2. [src/db/schema.ts](src/db/schema.ts): the table, and how migrations are made.
3. [src/server.ts](src/server.ts): the RPCs and events.
4. [src/client.ts](src/client.ts): the panel client and how its queries stay live.
5. [src/panel.tsx](src/panel.tsx): the Counters page and the widget.
6. [src/overlays/display.tsx](src/overlays/display.tsx): the OBS overlay.
7. [test/server.test.ts](test/server.test.ts), [test/panel.test.tsx](test/panel.test.tsx),
   [test/overlay.test.tsx](test/overlay.test.tsx), [test/contract.test.ts](test/contract.test.ts).

## Run it

1. Start `pnpm dev` in the repository root (`npx -y pnpm@12.10.1 dev`) and open
   http://127.0.0.1:5173. In dev the counter starts enabled the first time it's seen; if you
   disabled it, enable it in Admin › Plugins.
2. Open **Counters** in the sidebar, create a counter and count.
3. On the dashboard, choose **Edit**, add the **Counter** widget and pick your counter.
4. In Admin › Overlays, create a **counter › display** instance and watch its preview follow
   your clicks. Its URL goes into an OBS browser source.

## Change something

Save any file and the plugin rebuilds and reloads; the panel picks up the new bundle without a
page reload. For example, raise `step`'s maximum in `src/contract.ts` and look at the settings
form, or change the widget's look in `src/panel.module.css`.

## Add a migration

1. Change the table in `src/db/schema.ts`.
2. In `plugins/counter`, run `pnpm db:generate --name <change>`. drizzle-kit writes a new SQL
   file into `drizzle/`.
3. Save or rebuild: the core applies the migration when the plugin starts.

Never edit a migration that was already applied; add a new one.

## Learn more

- [Create a plugin](../../docs/plugin-guide.md#2-create-a-plugin) of your own
- [The contract](../../docs/plugin-guide.md#3-the-contract),
  [the server](../../docs/plugin-guide.md#4-the-server),
  [the client](../../docs/plugin-guide.md#5-the-client),
  [the panel](../../docs/plugin-guide.md#6-the-panel),
  [overlays](../../docs/plugin-guide.md#7-overlays),
  [testing](../../docs/plugin-guide.md#8-testing)
- [Watch out for](../../docs/plugin-guide.md#10-watch-out-for) and
  [when to use what](../../docs/plugin-guide.md#11-when-to-use-what)
