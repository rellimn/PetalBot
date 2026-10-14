import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { ContractShape, NoMembers, Role, SettingsOf } from '@petalbot/sdk';
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

type WidgetsOf<C> = C extends { widgets: infer W } ? W : NoMembers;
type ConfigSchemaOf<C, Id> = Id extends keyof WidgetsOf<C>
  ? WidgetsOf<C>[Id] extends { config: infer S extends z.ZodObject }
    ? S
    : undefined
  : undefined;

/** The widget ids a contract declares. */
export type WidgetId<C extends ContractShape> = keyof WidgetsOf<C> & string;
/** A widget instance's config as the component gets it: parsed with defaults (`{}` without config). */
export type WidgetConfig<C extends ContractShape, Id extends WidgetId<C>> =
  ConfigSchemaOf<C, Id> extends z.ZodObject ? z.output<ConfigSchemaOf<C, Id>> : NoMembers;
/** What a configure form saves: the config's input form. */
export type WidgetConfigInput<C extends ContractShape, Id extends WidgetId<C>> =
  ConfigSchemaOf<C, Id> extends z.ZodObject ? z.input<ConfigSchemaOf<C, Id>> : NoMembers;

export interface WidgetProps<C extends ContractShape, Id extends WidgetId<C>> {
  readonly config: WidgetConfig<C, Id>;
  /** Stable per placed instance; the same widget can be placed several times. */
  readonly instanceId: string;
}

/** Props of a widget's own configure form (replaces the generated one). */
export interface WidgetConfigureProps<C extends ContractShape, Id extends WidgetId<C>> {
  /** The current config, or undefined for a new or no longer valid instance. */
  readonly config: WidgetConfig<C, Id> | undefined;
  /** Validates against the contract's schema and stores the config; rejects with ApiError. */
  readonly save: (config: WidgetConfigInput<C, Id>) => Promise<void>;
  readonly cancel: () => void;
}

export interface PanelWidgetOptions<C extends ContractShape, Id extends WidgetId<C>> {
  readonly title: string;
  /** Shown in the "Add widget" list. */
  readonly description?: string;
  /** Default 'owner'. */
  readonly minRole?: Role;
  readonly component: ComponentType<WidgetProps<C, Id>>;
  readonly configure?: ComponentType<WidgetConfigureProps<C, Id>>;
}

export interface SettingsFormProps<C extends ContractShape = ContractShape> {
  /** The stored settings, parsed. */
  readonly values: z.output<SettingsOf<C>>;
  /** JSON Schema (zod input) of the settings, or null. */
  readonly schema: Readonly<Record<string, unknown>> | null;
  /** Merges `patch` into the stored values. Rejects with ApiError (`issues` for validation). */
  readonly save: (patch: Partial<z.input<SettingsOf<C>>>) => Promise<z.output<SettingsOf<C>>>;
}

export interface PanelOptions<C extends ContractShape> {
  readonly pages?: readonly PanelPage[];
  /** One entry per widget the contract declares. */
  readonly widgets?: { readonly [Id in WidgetId<C>]: PanelWidgetOptions<C, Id> };
  /** Replaces the generated settings form. */
  readonly settings?: ComponentType<SettingsFormProps<C>>;
}

/** What the panel passes to a widget component at runtime. */
export interface RuntimeWidgetProps {
  readonly config: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
}

export interface RuntimeConfigureProps {
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly save: (config: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly cancel: () => void;
}

/** What the panel passes to a custom settings form at runtime. */
export interface RuntimeSettingsProps {
  readonly values: Readonly<Record<string, unknown>>;
  readonly schema: Readonly<Record<string, unknown>> | null;
  readonly save: (
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface PanelWidget {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly minRole?: Role;
  /** The contract's config schema for this widget, if it has one. */
  readonly config?: z.ZodObject;
  readonly component: ComponentType<RuntimeWidgetProps>;
  readonly configure?: ComponentType<RuntimeConfigureProps>;
}

export interface PanelDefinition {
  readonly kind: 'petalbot.panel';
  readonly pluginId: string;
  readonly pages: readonly PanelPage[];
  readonly widgets: readonly PanelWidget[];
  readonly settings?: ComponentType<RuntimeSettingsProps>;
}

/** The default export of a plugin's panel bundle. Throws when `widgets` differs from the contract. */
export function definePanel<const C extends ContractShape>(
  contract: C,
  options: PanelOptions<C>,
): PanelDefinition {
  const declared = contract.widgets ?? {};
  // The typed per-widget options can't be assigned to the runtime shape (strictFunctionTypes).
  const given = (options.widgets ?? {}) as Readonly<Record<string, object>>;
  for (const id of Object.keys(declared)) {
    if (!Object.hasOwn(given, id)) {
      throw new Error(
        `Widget "${id}" is declared in contract "${contract.id}" but definePanel has no entry for it`,
      );
    }
  }
  const widgets = Object.entries(given).map(([id, widget]): PanelWidget => {
    if (!Object.hasOwn(declared, id)) {
      throw new Error(
        `definePanel has widget "${id}", which contract "${contract.id}" does not declare`,
      );
    }
    const config = declared[id]?.config;
    return {
      id,
      ...(widget as unknown as Omit<PanelWidget, 'id' | 'config'>),
      ...(config ? { config } : {}),
    };
  });
  return {
    kind: 'petalbot.panel',
    pluginId: contract.id,
    pages: options.pages ?? [],
    widgets,
    ...(options.settings
      ? { settings: options.settings as unknown as ComponentType<RuntimeSettingsProps> }
      : {}),
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
    throw new Error('The panel bundle must default-export definePanel(...)');
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
    if (
      widget.config !== undefined &&
      typeof (widget.config as { safeParse?: unknown }).safeParse !== 'function'
    ) {
      throw new Error(`Widget "${widget.id}" has a config that is not a zod object`);
    }
    if (widget.configure !== undefined && !isComponent(widget.configure)) {
      throw new Error(`Widget "${widget.id}" has a configure entry that is not a component`);
    }
  }
  if (panel.settings !== undefined && !isComponent(panel.settings)) {
    throw new Error('The custom settings form is not a component');
  }
  return panel as PanelDefinition;
}
