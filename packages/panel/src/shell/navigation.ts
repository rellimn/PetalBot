import { Settings } from 'lucide-react';
import type { Role } from '@petalbot/sdk';
import type { IconComponent, PanelDefinition, PluginInfo } from '@petalbot/ui-sdk';
import { hasRole } from '../app/roles.ts';

export type NavTarget =
  | {
      readonly to: '/p/$pluginId/$';
      readonly params: { readonly pluginId: string; readonly _splat: string };
    }
  | { readonly to: '/settings/$pluginId'; readonly params: { readonly pluginId: string } };

export interface NavLink {
  readonly kind: 'link';
  readonly key: string;
  readonly label: string;
  readonly icon?: IconComponent;
  /** The plugin is not running (shown greyed out; still clickable). */
  readonly disabled: boolean;
  readonly target: NavTarget;
}

export interface NavGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly items: readonly NavLink[];
}

export type NavEntry = NavLink | NavGroup;

const capitalize = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * One group per plugin: its pages the role may see, plus "Settings" for owners (unless the plugin
 * is known to have none). One visible page and no settings: a single link instead of a group.
 */
export function buildPluginNav(
  plugins: ReadonlyMap<string, PluginInfo>,
  known: ReadonlyMap<string, PanelDefinition>,
  role: Role,
): NavEntry[] {
  const entries: NavEntry[] = [];
  for (const info of [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const disabled = info.state !== 'running';
    const pages = (known.get(info.id)?.pages ?? []).filter((page) =>
      hasRole(role, page.minRole ?? 'owner'),
    );
    const links: NavLink[] = pages.map((page) => ({
      kind: 'link',
      key: `${info.id}/${page.path}`,
      label: page.title,
      ...(page.icon ? { icon: page.icon } : {}),
      disabled,
      target: { to: '/p/$pluginId/$', params: { pluginId: info.id, _splat: page.path } },
    }));
    const settings = role === 'owner' && info.hasSettings !== false;
    if (settings) {
      links.push({
        kind: 'link',
        key: `${info.id}/settings`,
        label: 'Settings',
        icon: Settings,
        disabled,
        target: { to: '/settings/$pluginId', params: { pluginId: info.id } },
      });
    }
    const [only] = links;
    if (links.length === 0) continue;
    if (links.length === 1 && only !== undefined && !settings) entries.push(only);
    else
      entries.push({
        kind: 'group',
        id: info.id,
        label: capitalize(info.id),
        disabled,
        items: links,
      });
  }
  return entries;
}

export interface Health {
  readonly tone: 'ok' | 'idle' | 'danger';
  /** Enabled plugins that failed or are degraded. */
  readonly problems: readonly PluginInfo[];
}

export function healthOf(plugins: ReadonlyMap<string, PluginInfo>): Health {
  const all = [...plugins.values()];
  const problems = all
    .filter((info) => info.enabled && (info.state === 'failed' || info.degraded))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (problems.length > 0) return { tone: 'danger', problems };
  return { tone: all.some((info) => info.state === 'running') ? 'ok' : 'idle', problems };
}
