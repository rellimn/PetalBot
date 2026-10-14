import type { Role } from '@petalbot/sdk';
import type { PanelWidget, PluginInfo } from '@petalbot/ui-sdk';
import type { PresetInput, WidgetInstance, WidgetRef } from '../app/endpoints.ts';
import { hasRole } from '../app/roles.ts';
import type { PanelState } from '../plugins/registry.ts';

export interface AvailableWidget {
  readonly ref: WidgetRef;
  readonly pluginId: string;
  readonly title: string;
  readonly description?: string;
  readonly widget: PanelWidget;
}

/** A key for a widget of the catalog (not for placed instances: those have ids). */
export const widgetKey = (ref: WidgetRef): string => `${ref.plugin}/${ref.widget}`;

/** A required config field has no default, so the widget can't be placed unconfigured. */
export const needsConfig = (widget: PanelWidget): boolean =>
  widget.config !== undefined && !widget.config.safeParse({}).success;

/**
 * 128 random bits as hex. Not crypto.randomUUID(): browsers only offer it in secure contexts, and
 * a self-hosted panel is often opened over plain http on the LAN.
 */
function instanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A new placed instance. Widgets with a config schema store their (input) config, others none. */
export function newInstance(
  ref: WidgetRef,
  widget: PanelWidget,
  config: Readonly<Record<string, unknown>> = {},
): WidgetInstance {
  return { id: instanceId(), ...ref, ...(widget.config ? { config } : {}) };
}

/** Widgets of loaded bundles the role may see, sorted by plugin id, in declaration order. */
export function availableWidgets(
  panels: ReadonlyMap<string, PanelState>,
  role: Role,
): AvailableWidget[] {
  return [...panels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([pluginId, state]) =>
      state.status === 'ready'
        ? state.panel.widgets
            .filter((widget) => hasRole(role, widget.minRole ?? 'owner'))
            .map((widget) => ({
              ref: { plugin: pluginId, widget: widget.id },
              pluginId,
              title: widget.title,
              ...(widget.description === undefined ? {} : { description: widget.description }),
              widget,
            }))
        : [],
    );
}

/** The first preset of a new user: the first widget large, the rest at the side; never unconfigured ones. */
export function starterPreset(widgets: readonly AvailableWidget[]): PresetInput {
  const [main, ...side] = widgets
    .filter((available) => !needsConfig(available.widget))
    .map((available) => newInstance(available.ref, available.widget));
  return {
    name: 'My dashboard',
    columns: [
      { width: 70, widgets: main ? [main] : [] },
      { width: 30, widgets: side },
    ],
  };
}

/** Every running plugin with a panel has finished loading its bundle (or failed to). */
export function bundlesSettled(
  plugins: ReadonlyMap<string, PluginInfo>,
  panels: ReadonlyMap<string, PanelState>,
): boolean {
  return [...plugins.values()].every((info) => {
    if (info.state !== 'running' || !info.panel) return true;
    const status = panels.get(info.id)?.status;
    return status === 'ready' || status === 'error';
  });
}
