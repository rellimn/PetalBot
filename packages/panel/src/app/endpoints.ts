import type { EventEnvelope } from '@petalbot/sdk';
import type {
  Api,
  Appearance,
  LogEntry,
  LogLevel,
  Me,
  PluginInfo,
  PluginList,
} from '@petalbot/ui-sdk';

// The typed boundary to the REST API (docs/api/openapi.json). Nothing else casts responses.

export const loadMe = async (api: Api): Promise<Me> => (await api.get('/api/me')) as Me;

export const loadPlugins = async (api: Api): Promise<PluginList> =>
  (await api.get('/api/plugins')) as PluginList;

const pluginPath = (id: string, action: string): string =>
  `/api/plugins/${encodeURIComponent(id)}/${action}`;

export const enablePlugin = async (api: Api, id: string, withDependencies = false) =>
  (await api.post(pluginPath(id, 'enable'), { withDependencies })) as PluginInfo;

export const disablePlugin = async (api: Api, id: string, withDependents = false) =>
  (await api.post(pluginPath(id, 'disable'), { withDependents })) as PluginInfo;

export const reloadPlugin = async (api: Api, id: string) =>
  (await api.post(pluginPath(id, 'reload'))) as PluginInfo;

export const rescanPlugins = async (api: Api): Promise<void> => {
  await api.post('/api/plugins/rescan');
};

export interface DeletedData {
  readonly droppedTables: readonly string[];
  readonly overlayInstances: number;
}

export const deletePluginData = async (api: Api, id: string) =>
  (await api.delete(pluginPath(id, 'data'), { confirm: id })) as DeletedData;

export interface PluginSettings {
  readonly values: Readonly<Record<string, unknown>>;
  readonly schema: Readonly<Record<string, unknown>> | null;
}

export const loadSettings = async (api: Api, id: string) =>
  (await api.get(pluginPath(id, 'settings'))) as PluginSettings;

export const saveSettings = async (
  api: Api,
  id: string,
  patch: Readonly<Record<string, unknown>>,
) =>
  ((await api.patch(pluginPath(id, 'settings'), patch)) as { values: Record<string, unknown> })
    .values;

export interface LogQuery {
  readonly plugin?: string;
  readonly level?: LogLevel;
  readonly before?: number;
  readonly limit?: number;
}

export const loadLogs = async (api: Api, query: LogQuery): Promise<readonly LogEntry[]> => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return (
    (await api.get(`/api/logs${search === '' ? '' : `?${search}`}`)) as {
      entries: LogEntry[];
    }
  ).entries;
};

export const loadEvents = async (api: Api, before?: string): Promise<readonly EventEnvelope[]> =>
  (
    (await api.get(
      `/api/events${before === undefined ? '' : `?before=${encodeURIComponent(before)}`}`,
    )) as { events: EventEnvelope[] }
  ).events;

export interface Preferences extends Appearance {
  readonly activePreset: string | null;
}

export const loadPreferences = async (api: Api) =>
  (await api.get('/api/me/preferences')) as Preferences;

export const savePreferences = async (api: Api, preferences: Preferences) =>
  (await api.put('/api/me/preferences', preferences)) as Preferences;

export interface WidgetRef {
  readonly plugin: string;
  readonly widget: string;
}

export interface PresetColumn {
  readonly width: number;
  readonly widgets: readonly WidgetRef[];
}

export interface PresetInput {
  readonly name: string;
  readonly columns: readonly PresetColumn[];
}

export interface Preset extends PresetInput {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const loadPresets = async (api: Api): Promise<readonly Preset[]> =>
  ((await api.get('/api/me/presets')) as { presets: Preset[] }).presets;

export const createPreset = async (api: Api, input: PresetInput) =>
  (await api.post('/api/me/presets', input)) as Preset;

export const updatePreset = async (api: Api, id: string, input: PresetInput) =>
  (await api.put(`/api/me/presets/${encodeURIComponent(id)}`, input)) as Preset;

export const deletePreset = async (api: Api, id: string): Promise<void> => {
  await api.delete(`/api/me/presets/${encodeURIComponent(id)}`);
};

export interface OverlayInstance {
  readonly id: string;
  readonly pluginId: string;
  readonly overlay: string;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly rotatedAt: number;
}

/** An overlay a running plugin declares (instances can be created for it). */
export interface DeclaredOverlay {
  readonly pluginId: string;
  readonly overlay: string;
  /** JSON Schema (input) of the instance config. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly hasBundle: boolean;
}

export interface OverlayList {
  readonly instances: readonly OverlayInstance[];
  readonly overlays: readonly DeclaredOverlay[];
}

/** Returned once, on creation and rotation: the only time the token is visible. */
export interface OverlayToken {
  readonly instance: OverlayInstance;
  readonly token: string;
  readonly url: string;
}

export interface NewOverlay {
  readonly pluginId: string;
  readonly overlay: string;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface OverlayChanges {
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

const overlayPath = (id: string, action = ''): string =>
  `/api/overlays/${encodeURIComponent(id)}${action}`;

export const loadOverlays = async (api: Api) => (await api.get('/api/overlays')) as OverlayList;

export const createOverlay = async (api: Api, input: NewOverlay) =>
  (await api.post('/api/overlays', input)) as OverlayToken;

export const updateOverlay = async (api: Api, id: string, changes: OverlayChanges) =>
  (await api.patch(overlayPath(id), changes)) as OverlayInstance;

export const rotateOverlay = async (api: Api, id: string) =>
  (await api.post(overlayPath(id, '/rotate'))) as OverlayToken;

export const revokeOverlay = async (api: Api, id: string): Promise<void> => {
  await api.delete(overlayPath(id));
};
