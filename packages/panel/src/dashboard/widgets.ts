import type { Role } from '@petalbot/sdk';
import type { PluginInfo } from '@petalbot/ui-sdk';
import type { PresetInput, WidgetRef } from '../app/endpoints.ts';
import { hasRole } from '../app/roles.ts';
import type { PanelState } from '../plugins/registry.ts';

export interface AvailableWidget {
  readonly ref: WidgetRef;
  readonly pluginId: string;
  readonly title: string;
  readonly description?: string;
}

export const widgetKey = (ref: WidgetRef): string => `${ref.plugin}/${ref.widget}`;

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
            }))
        : [],
    );
}

/** The first preset of a new user: the first widget large, everything else at the side. */
export function starterPreset(widgets: readonly AvailableWidget[]): PresetInput {
  const [main, ...side] = widgets;
  return {
    name: 'My dashboard',
    columns: [
      { width: 70, widgets: main ? [main.ref] : [] },
      { width: 30, widgets: side.map((widget) => widget.ref) },
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
