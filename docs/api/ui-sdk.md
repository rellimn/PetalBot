# PetalBot UI SDK (`@petalbot/ui-sdk`)

Everything panel and overlay code needs: a typed client, React hooks, components and theme tokens. The panel and the overlay host share their copy with plugin bundles through the import map, so state (connection, toasts, query cache) is shared too.

## Client

```ts
// src/client.ts: once, at module scope
export const api = createPluginClient(counterContract, {
  dependencies: [chatContract],
  queries: {
    'counter.list': { refreshOn: ['counter.listChanged'] },
    'counter.get': {
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

// components
const list = api.counter.list.useQuery(); // RPC without input
const one = api.counter.get.useQuery({ counter: id }, { enabled: open });
const increment = api.counter.increment.useMutation({ error: 'Could not count' });
increment.mutate({ counter: id });
await api.chat.send.call({ text: 'hi' }); // also outside components
api.counter.changed.useEvent((event) => playSound());
```

- **Shape:** `api.<contractId>.<member>` mirrors the qualified name. There's one namespace for the own contract and one per dependency, with only the members the client may use: for the panel, RPCs with `expose.panel` and events exposed to `panel`; for an overlay, what its declaration lists.
- **Read or write comes from the contract:** RPCs with `kind: 'query'` get `useQuery(input?, { enabled, refetchInterval })` (a TanStack query). All other RPCs get `useMutation({ success?, error?, presentFailure?, onMutate?, onSuccess?, onError?, onSettled? })` (a TanStack mutation; `mutate()` takes no argument for RPCs without input). Every RPC has `call(input?)`, and every event has `useEvent(handler)`. `queries` accepts only query RPCs and `mutations` only mutation RPCs; a query not listed in `queries` is a plain query.
- **Freshness is declared once per client, not per component:**

| Option                                            | On the event                           | Round trip | Good for                                             |
| ------------------------------------------------- | -------------------------------------- | ---------- | ---------------------------------------------------- |
| `refreshOn: [events]`                             | refetches the query (payload ignored)  | yes        | the default; lists; payloads without the full answer |
| `update: { event: (data, event, input) => next }` | computes the new data from the payload | none       | busy streams, payloads that carry the new value      |

`update` runs once per cached entry (one per input); `input` is that entry's input. Return `data` unchanged when the event doesn't concern the entry, and a new object when it does (never mutate). It only runs when the entry has data and no fetch is in flight; otherwise the query refetches. Live queries refetch after a reconnect.

- **Invalidation:** after a successful mutation, every query of the client's own contract (listed in `queries` or not) is refetched in this tab. `mutations: { name: { invalidates: [...] } }` replaces that list, and `[]` turns it off. Other tabs, users and overlays only learn about changes through events, so state that others display must be announced with an event.
- **Toasts:** `success` and `error` (a string or a function) raise a toast. A decoded Result failure uses category fallback text or an explicit `presentFailure` callback; diagnostic `message` is never used automatically. Returned failures still resolve the mutation (`isSuccess`, `onSuccess`); only rejected calls invoke `onError`. Successful values alone trigger the success toast. Invalidation runs for every resolved value, including returned failures.
- **Query for what _is_, `useEvent` for what _happened_:** displayed state comes from a query; `useEvent` is for sounds, animations, alerts and toasts.
- **Hook rules:** `api.x.y.useQuery()` and the other handle methods are hooks. ESLint can't check member-chain calls, so never call them conditionally or in loops.

| Export                                                                  | Purpose                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPluginClient(contract, { dependencies?, queries?, mutations? })` | The panel client described above.                                                                                                                                    |
| `createOverlayClient(contract, name, { queries?, mutations? })`         | The same for an overlay: only the events and RPCs its declaration lists.                                                                                             |
| `QueryRpcName<All, Names>`, `MutationRpcName<All, Names>`               | The names in `Names` whose RPC is a query, or a mutation.                                                                                                            |
| `defineOverlay(contract, name, { component })`                          | Default export of `src/overlays/<name>.tsx`; the component gets `{ config }` (`OverlayProps`).                                                                       |
| `OverlayConfig<typeof contract, 'name'>`                                | The parsed config type of an overlay (defaults applied).                                                                                                             |
| `rpcQueryKey(name, input)`                                              | The TanStack key of an RPC query: `['petalbot', 'rpc', name, input]`.                                                                                                |
| `ConnectionProvider`                                                    | Provides only the connection (the overlay host uses it); `PetalProvider` includes it.                                                                                |
| `usePlugins()`, `usePlugin(id)`, `usePluginsLoaded()`                   | Live `PluginInfo` of every plugin.                                                                                                                                   |
| `useUser()`                                                             | `{ id, name, role }` of the logged-in user.                                                                                                                          |
| `useConnectionStatus()`                                                 | `'connecting' \| 'open' \| 'reconnecting' \| 'ended'`.                                                                                                               |
| `useConnection().state`                                                 | `ReadonlyStore` of `{ status, plugins, pluginsLoaded, problems }` for `useStore` or `subscribe`.                                                                     |
| `useApi()`                                                              | JSON over HTTP (`get/post/put/patch/delete`, results are `unknown`), e.g. for `/api/p/<id>/…` routes.                                                                |
| `toast(input)`, `useToast()`                                            | `toast({ title, description?, tone?: 'info' \| 'success' \| 'warning' \| 'danger', durationMs? })`, also outside components. `useToast()` returns the same function. |
| `ClientError`, `ApiError`                                               | Error classes (`code`, `message`; `ApiError` also `status`, `plugins`, `issues`).                                                                                    |

Clients decode event payloads and RPC results with the contract schemas (codecs, see plugin-api.md, section Data that reaches the browser). `useUser()`, `useApi()` and `usePlugins()` exist only in the panel; overlays have no user session.

## Widgets and settings

```tsx
function CounterWidget({ config, instanceId }: WidgetProps<typeof counterContract, 'value'>) {
  const counter = api.counter.get.useQuery({ counter: config.counter });
  …
}
function CounterSettings({ values, save }: SettingsFormProps<typeof counterContract>) { … }
```

| Type                          | Meaning                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WidgetProps<C, Id>`          | `{ config, instanceId }`. `config` is parsed with the contract's widget schema (defaults applied; `{}` without config). The same widget can be placed several times; each instance has its own id and config. |
| `WidgetConfigureProps<C, Id>` | Props of a widget's own `configure` form: `{ config, save, cancel }`. `config` is undefined for a new or no longer valid instance; `save` validates against the schema.                                       |
| `SettingsFormProps<C>`        | Props of a custom settings form: `values` (parsed), `schema` (JSON Schema), `save(patch)`.                                                                                                                    |

- **Dashboard behavior:**
  - A widget whose config has a required field without a default opens its configure form when it's added.
  - A stored config that no longer parses (the plugin changed its schema) shows "Needs configuration" with a Configure button. The component is never called with an invalid config.
  - Frames are titled "Widget · Label" from the config's first `choice()` field. The label comes from the choice RPC, and a value it no longer lists shows "(deleted)".
- **Generated forms:** `choice()` fields render as a select filled by the named RPC, in settings, widget config and overlay config alike. A stored value the RPC no longer lists stays visible as "Unknown: <value>".

## State

| Export                                | Purpose                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createStore(initial, { name? })`     | Client state at module scope: `get()`, `set(partial \| updater)` (merges one level), `subscribe(listener)`, `reset()`. `name` shows the store in the Redux DevTools extension in dev builds. |
| `useStore(store, selector, shallow?)` | Reads `selector(state)` and re-renders only when it changes. Pass `shallow` when the selector builds a new object or array.                                                                  |
| `Store<T>`, `ReadonlyStore<T>`        | Store types. Read-only stores (e.g. `connection.state`) have no `set` or `reset`.                                                                                                            |

Keep only UI state in stores: drafts, filters, a selection shared by a widget and a page. Data the
server owns (values, queues, recent events) belongs in the plugin's server code and reaches the
panel through a live query (`useQuery`, see Client above). Never mutate state; `set` replaces it. A plugin
reload starts with fresh stores.

## Components

| Component           | Props (besides the usual HTML ones)                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `Button`            | `variant: 'primary' \| 'secondary' \| 'ghost' \| 'danger'`, `size: 'md' \| 'sm'`, `icon`, `loading` |
| `IconButton`        | `label` (required, accessible name), `icon`, `variant`, `size`                                      |
| `Card`              | `title`, `actions`, `children`: the panel's 8 px surface for widgets and sections                   |
| `Badge`             | `tone: 'neutral' \| 'accent' \| 'success' \| 'warning' \| 'danger'`                                 |
| `StatusDot`         | `tone: 'ok' \| 'idle' \| 'warning' \| 'danger'`, `label`, `pulse`                                   |
| `Field`             | `label`, `help`, `error`; wires the `Input`/`Textarea`/`Select` inside it                           |
| `Input`, `Textarea` | native props                                                                                        |
| `Select`            | `options: { value, label }[]` + native props                                                        |
| `Checkbox`          | `label`, `checked`, `onCheckedChange`                                                               |
| `Switch`            | `label`, `checked`, `onCheckedChange`                                                               |
| `Dialog`            | `open`, `onOpenChange`, `title`, `description`, `footer`                                            |
| `ConfirmDialog`     | `title`, `message`, `confirmLabel`, `tone`, `busy`, `requireText`, `onConfirm`, `onCancel`          |
| `Menu`              | `label`, `items: { label, onSelect, tone?, disabled?, icon? }[]`, `trigger?`                        |
| `Popover`           | `trigger`, `label`, `align`                                                                         |
| `Banner`            | `tone`, `action`                                                                                    |
| `Spinner`           | `size`, `label` (`null` hides it from screen readers)                                               |
| `EmptyState`        | `title`, `action`                                                                                   |
| `Numeric`           | tabular figures for numbers and timers                                                              |

## Tokens

Plugins style with these CSS variables only; every color scheme and both densities define them.

The shared theme also loads Nunito Sans with optical baseline correction for all text in the panel
and overlay host, preserving line spacing. Use `--pb-font-family` for regular UI text (about 1 px
correction at 15 px) and `--pb-font-family-display` with `--pb-font-size-xl` or larger text for a gentler
correction (about 0.5 px at 27 px and 1 px at 54 px).

- Colors:
  - surfaces: `--pb-bg`, `--pb-surface-1` (bars), `--pb-surface-2` (cards), `--pb-surface-3` (rows, inputs), `--pb-border`
  - text: `--pb-text`, `--pb-text-muted`
  - accent: `--pb-accent`, `--pb-accent-fg`, `--pb-accent-text` (accent as text color), `--pb-brand` (may be a gradient)
  - status and focus: `--pb-success`, `--pb-warning`, `--pb-danger`, `--pb-danger-fg`, `--pb-focus-ring`, `--pb-backdrop`
- Size: `--pb-font-size`, `-sm`, `-lg`, `-xl`, `--pb-line-height`, `--pb-space-1` … `--pb-space-5`,
  `--pb-row-pad-y`, `--pb-row-pad-x`, `--pb-row-gap`, `--pb-control-height`
- Fixed: `--pb-radius-lg` (8 px, cards), `--pb-radius-md` (6 px, rows/inputs), `--pb-radius-sm`
  (4 px, badges/buttons), `--pb-font-family` and `--pb-font-family-display` (Nunito Sans), `--pb-font-weight-regular|medium|bold`,
  `--pb-transition`

Schemes: dark Rose (default), Lavender, Spring Leaf, Peach Blossom, Dark Gray; light Light (default),
Cream. Densities: Comfortable (default), Compact. Each user picks them in the user menu.

## Failure presentation

`presentFailure(failure, presenter?)` is a pure helper returning user-facing text.
`FailurePresenter<F extends Failure>` is `(failure: F) => string | undefined`. A presenter may
handle only useful contextual cases and return `undefined` for the category fallback; an empty
string is intentional. Exceptions from presenters propagate. The helper never reads diagnostic
`message`, logs, or emits a toast.

| Category         | Fallback                                            |
| ---------------- | --------------------------------------------------- |
| `unsupported`    | This action is not supported.                       |
| `forbidden`      | This action is not allowed.                         |
| `not-found`      | The requested item could not be found.              |
| `rate-limited`   | Too many requests. Please try again later.          |
| `platform-error` | The external service could not complete the action. |
| `custom`         | The action could not be completed.                  |

```ts
const increment = api.counter.increment.useMutation({
  error: 'Could not count',
  presentFailure: (failure) => {
    // Exact declared payload, including failure.error.counterId.
    if (failure.error.code === 'counter-not-found') return 'This counter no longer exists.';
    return undefined;
  },
});
```

The option is typed to `Extract<Output, Failure>` and unavailable for scalar, ordinary object,
success-only or broadcast-record outputs. It only runs when an automatic `error` toast is
requested. Nested Results are handled explicitly by the caller. Function-form `error` receives
`{ message: presentationText }` for returned failures; rejected RPCs keep their `ClientError`.

`onMutate`, `onSuccess`, `onError` and `onSettled` retain TanStack's arguments, inferred rollback
context and awaited sequencing. `onSuccess` receives the original decoded Result, including any
diagnostics, even on failure; per-call callbacks behave the same way. This is independent of
whether toasts are enabled. There are no new automatic retries.
