import type { ComponentType } from 'react';
import type { ContractShape, Role } from '@petalbot/sdk';
import type { IconComponent } from './components/icon.ts';

export interface PanelPage {
  /** URL segment(s) under `/p/<pluginId>/`, e.g. `quotes` or `quotes/history`. */
  readonly path: string;
  readonly title: string;
  readonly icon?: IconComponent;
  /** Default 'owner'. */
  readonly minRole?: Role;
  readonly component: ComponentType;
}

export interface PanelWidget {
  /** Unique within the plugin; presets store `{ plugin, widget: id }`. */
  readonly id: string;
  readonly title: string;
  /** Shown in the "Add widget" list. */
  readonly description?: string;
  /** Default 'owner'. */
  readonly minRole?: Role;
  readonly component: ComponentType;
}

export interface SettingsFormProps {
  /** The stored values. */
  readonly values: Readonly<Record<string, unknown>>;
  /** JSON Schema (zod input) of the settings, or null. */
  readonly schema: Readonly<Record<string, unknown>> | null;
  /** Merges `patch` into the stored values. Rejects with ApiError (`issues` for validation). */
  readonly save: (
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface PanelOptions {
  readonly pages?: readonly PanelPage[];
  readonly widgets?: readonly PanelWidget[];
  /** Replaces the generated settings form. */
  readonly settings?: ComponentType<SettingsFormProps>;
}

export interface PanelDefinition {
  readonly kind: 'petalbot.panel';
  readonly pluginId: string;
  readonly pages: readonly PanelPage[];
  readonly widgets: readonly PanelWidget[];
  readonly settings?: ComponentType<SettingsFormProps>;
}

/** The default export of a plugin's panel bundle. */
export function definePanel(contract: ContractShape, options: PanelOptions): PanelDefinition {
  return {
    kind: 'petalbot.panel',
    pluginId: contract.id,
    pages: options.pages ?? [],
    widgets: options.widgets ?? [],
    ...(options.settings ? { settings: options.settings } : {}),
  };
}

const PAGE_PATH = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const WIDGET_ID = /^[a-z][a-z0-9-]*$/;

export const isComponent = (value: unknown): boolean =>
  typeof value === 'function' ||
  (typeof value === 'object' && value !== null && '$$typeof' in value);
const isRole = (value: unknown): boolean =>
  value === undefined || value === 'owner' || value === 'mod';

/** Validates a bundle's default export; throws an Error that explains the problem. */
export function checkPanelDefinition(value: unknown, pluginId: string): PanelDefinition {
  const panel = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Partial<PanelDefinition>;
  if (panel.kind !== 'petalbot.panel') {
    throw new Error('The panel bundle must default-export definePanel(…)');
  }
  if (panel.pluginId !== pluginId) {
    throw new Error(`The panel bundle belongs to "${String(panel.pluginId)}", not "${pluginId}"`);
  }
  // Annotated: Array.isArray widens readonly arrays to any[].
  const pages: readonly PanelPage[] = Array.isArray(panel.pages) ? panel.pages : [];
  const paths = new Set<string>();
  for (const page of pages) {
    if (!PAGE_PATH.test(page.path)) {
      throw new Error(`Invalid page path "${page.path}" (expected ${String(PAGE_PATH)})`);
    }
    if (paths.has(page.path)) throw new Error(`Duplicate page path "${page.path}"`);
    paths.add(page.path);
    if (!isComponent(page.component)) throw new Error(`Page "${page.path}" has no component`);
    if (!isRole(page.minRole)) throw new Error(`Page "${page.path}" has an unknown minRole`);
  }
  const widgets: readonly PanelWidget[] = Array.isArray(panel.widgets) ? panel.widgets : [];
  const ids = new Set<string>();
  for (const widget of widgets) {
    if (!WIDGET_ID.test(widget.id)) throw new Error(`Invalid widget id "${widget.id}"`);
    if (ids.has(widget.id)) throw new Error(`Duplicate widget id "${widget.id}"`);
    ids.add(widget.id);
    if (!isComponent(widget.component)) throw new Error(`Widget "${widget.id}" has no component`);
    if (!isRole(widget.minRole)) throw new Error(`Widget "${widget.id}" has an unknown minRole`);
  }
  if (panel.settings !== undefined && !isComponent(panel.settings)) {
    throw new Error('The custom settings form is not a component');
  }
  return panel as PanelDefinition;
}
