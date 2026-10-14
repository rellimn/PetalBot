import type { PanelUser } from '@petalbot/sdk';

export type PluginState = 'disabled' | 'starting' | 'running' | 'stopping' | 'failed';

export interface PanelBundleInfo {
  readonly entry: string;
  readonly styles: readonly string[];
}

/** A plugin as `GET /api/plugins` and `plugin.state` describe it. */
export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  readonly dir: string;
  readonly state: PluginState;
  readonly enabled: boolean;
  readonly degraded: boolean;
  readonly error?: string;
  readonly dependencies: readonly string[];
  readonly optionalDependencies: readonly string[];
  readonly hasPanel: boolean;
  /** Has settings or user-settable secrets; absent until the core has loaded the definition. */
  readonly hasSettings?: boolean;
  readonly panel?: PanelBundleInfo;
}

export interface DiscoveryProblem {
  readonly dir: string;
  readonly message: string;
}

export interface PluginList {
  readonly plugins: readonly PluginInfo[];
  readonly problems: readonly DiscoveryProblem[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly id: number;
  readonly time: number;
  readonly level: LogLevel;
  readonly plugin?: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** URLs of an overlay's bundle while its plugin runs (from `hello` and `plugin.state`). */
export interface OverlayBundleInfo {
  readonly hash: string;
  readonly entry: string;
  readonly styles: readonly string[];
}

/** What an overlay connection knows about its instance. */
export interface OverlaySession {
  /** The stored config; the overlay host parses it with the overlay's schema. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Null while the plugin is not running or has no bundle for this overlay. */
  readonly bundle: OverlayBundleInfo | null;
}

export type Identity =
  | { readonly kind: 'panel'; readonly user: PanelUser }
  | {
      readonly kind: 'overlay';
      readonly instanceId: string;
      readonly pluginId: string;
      readonly overlay: string;
      /** The panel's live preview (owner session instead of the token). */
      readonly preview: boolean;
    };

/** `GET /api/me`. */
export interface Me {
  readonly user: PanelUser;
  readonly devAuth: boolean;
}
