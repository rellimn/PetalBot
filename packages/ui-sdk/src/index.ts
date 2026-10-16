export { presentFailure, type FailurePresenter } from './failure.ts';
export {
  COLOR_TOKENS,
  DARK_SCHEMES,
  DEFAULT_APPEARANCE,
  DENSITY_TOKENS,
  LIGHT_SCHEMES,
  applyAppearance,
  isDarkScheme,
  resolveScheme,
  type Appearance,
  type ColorMode,
  type DarkScheme,
  type Density,
  type LightScheme,
  type Scheme,
} from './theme/appearance.ts';
export {
  createStore,
  shallow,
  useStore,
  type ReadonlyStore,
  type Store,
  type StoreOptions,
} from './store.ts';
export { Badge, type Tone } from './components/Badge.tsx';
export { Banner, type BannerProps } from './components/Banner.tsx';
export { Button, type ButtonProps, type ButtonVariant } from './components/Button.tsx';
export { Card, type CardProps } from './components/Card.tsx';
export {
  ConfirmDialog,
  Dialog,
  type ConfirmDialogProps,
  type DialogProps,
} from './components/Dialog.tsx';
export { EmptyState, type EmptyStateProps } from './components/EmptyState.tsx';
export { Field, useFieldControl, type FieldProps } from './components/Field.tsx';
export { IconButton, type IconButtonProps } from './components/IconButton.tsx';
export type { IconComponent } from './components/icon.ts';
export {
  Checkbox,
  Input,
  Select,
  Textarea,
  type CheckboxProps,
  type SelectOption,
  type SelectProps,
} from './components/Input.tsx';
export { Menu, type MenuItem, type MenuProps } from './components/Menu.tsx';
export { Numeric } from './components/Numeric.tsx';
export { Popover, type PopoverProps } from './components/Popover.tsx';
export { Spinner, type SpinnerProps } from './components/Spinner.tsx';
export { StatusDot, type StatusDotProps } from './components/StatusDot.tsx';
export { Switch, type SwitchProps } from './components/Switch.tsx';
export { Toaster, toast, useToast, type ToastInput } from './components/Toaster.tsx';
export {
  PetalConnection,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionStatus,
  type SocketLike,
} from './client/connection.ts';
export { ApiError, ClientError, type ApiIssue } from './client/errors.ts';
export { createApi, type Api, type ApiOptions } from './client/http.ts';
export type {
  DiscoveryProblem,
  Identity,
  LogEntry,
  LogLevel,
  Me,
  OverlayBundleInfo,
  OverlaySession,
  PanelBundleInfo,
  PluginInfo,
  PluginList,
  PluginState,
} from './client/types.ts';
export {
  ConnectionProvider,
  PetalProvider,
  currentConnection,
  registerConnection,
  useApi,
  useConnection,
  useConnectionStatus,
  usePetal,
  usePlugin,
  usePlugins,
  usePluginsLoaded,
  useUser,
  type PetalContextValue,
} from './client/context.tsx';
export {
  createOverlayClient,
  createPluginClient,
  rpcQueryKey,
  type ClientApi,
  type EventHandle,
  type EventPayload,
  type MutationDefinitions,
  type MutationHandle,
  type MutationOptions,
  type MutationRpcName,
  type PanelEventName,
  type PanelRpcName,
  type QueryDefinition,
  type QueryDefinitions,
  type QueryHandle,
  type QueryRpcName,
  type QueryUseOptions,
  type RpcInput,
  type RpcOutput,
} from './client/plugin-client.ts';
export {
  checkPanelDefinition,
  definePanel,
  type PanelDefinition,
  type PanelOptions,
  type PanelPage,
  type PanelWidget,
  type PanelWidgetOptions,
  type RuntimeConfigureProps,
  type RuntimeSettingsProps,
  type RuntimeWidgetProps,
  type SettingsFormProps,
  type WidgetConfig,
  type WidgetConfigInput,
  type WidgetConfigureProps,
  type WidgetId,
  type WidgetProps,
} from './panel.ts';
export {
  checkOverlayDefinition,
  defineOverlay,
  type OverlayConfig,
  type OverlayDefinition,
  type OverlayEvents,
  type OverlayName,
  type OverlayOptions,
  type OverlayProps,
  type OverlayRpcs,
  type OverlayEventName,
  type OverlayRpcName,
  type OverlayScope,
} from './overlay.ts';
