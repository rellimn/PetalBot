# PetalBot UI SDK (`@petalbot/ui-sdk`)

Everything panel and overlay code needs: a typed client, React hooks, components and theme tokens. The panel and the overlay host share their copy with plugin bundles through the import map, so state (connection, toasts, query cache) is shared too.

## Client

| Export                                                | Purpose                                                                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPluginClient(contract, deps?)`                 | Typed `useEvent`, `useRpc`, `useMutation`, `call` (see plugin-api.md).                                                                                               |
| `createOverlayClient(contract, name)`                 | The same for an overlay: only the events and RPCs its declaration lists.                                                                                             |
| `defineOverlay(contract, name, { component })`        | Default export of `src/overlays/<name>.tsx`; the component gets `{ config }` (`OverlayProps`).                                                                       |
| `OverlayConfig<typeof contract, 'name'>`              | The parsed config type of an overlay (defaults applied).                                                                                                             |
| `ConnectionProvider`                                  | Provides only the connection (the overlay host uses it); `PetalProvider` includes it.                                                                                |
| `usePlugins()`, `usePlugin(id)`, `usePluginsLoaded()` | Live `PluginInfo` of every plugin.                                                                                                                                   |
| `useUser()`                                           | `{ id, name, role }` of the logged-in user.                                                                                                                          |
| `useConnectionStatus()`                               | `'connecting' \| 'open' \| 'reconnecting' \| 'ended'`.                                                                                                               |
| `useConnection().state`                               | `ReadonlyStore` of `{ status, plugins, pluginsLoaded, problems }` for `useStore` or `subscribe`.                                                                     |
| `useApi()`                                            | JSON over HTTP (`get/post/put/patch/delete`, results are `unknown`), e.g. for `/api/p/<id>/…` routes.                                                                |
| `toast(input)`, `useToast()`                          | `toast({ title, description?, tone?: 'info' \| 'success' \| 'warning' \| 'danger', durationMs? })`, also outside components. `useToast()` returns the same function. |
| `ClientError`, `ApiError`                             | Error classes (`code`, `message`; `ApiError` also `status`, `plugins`, `issues`).                                                                                    |

Clients decode event payloads and RPC results with the contract schemas (codecs, see plugin-api.md, section Data that reaches the browser). `useUser()`, `useApi()` and `usePlugins()` exist only in the panel; overlays have no user session.

## State

| Export                                | Purpose                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createStore(initial, { name? })`     | Client state at module scope: `get()`, `set(partial \| updater)` (merges one level), `subscribe(listener)`, `reset()`. `name` shows the store in the Redux DevTools extension in dev builds. |
| `useStore(store, selector, shallow?)` | Reads `selector(state)` and re-renders only when it changes. Pass `shallow` when the selector builds a new object or array.                                                                  |
| `Store<T>`, `ReadonlyStore<T>`        | Store types. Read-only stores (e.g. `connection.state`) have no `set` or `reset`.                                                                                                            |

Keep only UI state in stores: drafts, filters, a selection shared by a widget and a page. Data the
server owns (values, queues, recent events) belongs in the plugin's server code and reaches the
panel through a live `useRpc` (plugin-api.md). Never mutate state; `set` replaces it. A plugin
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
