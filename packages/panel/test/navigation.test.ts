import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel, type PanelDefinition, type PluginInfo } from '@petalbot/ui-sdk';
import { buildPluginNav, healthOf } from '../src/shell/navigation.ts';
import { pluginInfo } from './harness.tsx';

const Page = () => null;
const queue = definePanel(defineContract({ id: 'queue', version: '1.0.0' }), {
  pages: [
    { path: 'list', title: 'Queue', minRole: 'mod', component: Page },
    { path: 'history', title: 'Queue history', component: Page },
  ],
});
const quotes = definePanel(defineContract({ id: 'quotes', version: '1.0.0' }), {
  pages: [{ path: 'list', title: 'Quotes', minRole: 'mod', component: Page }],
});

const map = <T extends { id: string }>(...items: T[]) =>
  new Map(items.map((item) => [item.id, item]));
const known = (...panels: PanelDefinition[]) =>
  new Map(panels.map((panel) => [panel.pluginId, panel]));

describe('buildPluginNav', () => {
  it('groups pages and settings per plugin for owners', () => {
    const nav = buildPluginNav(
      map(pluginInfo('queue'), pluginInfo('quotes', { hasSettings: false })),
      known(queue, quotes),
      'owner',
    );
    expect(nav).toEqual([
      {
        kind: 'group',
        id: 'queue',
        label: 'Queue',
        disabled: false,
        items: [
          expect.objectContaining({
            label: 'Queue',
            target: { to: '/p/$pluginId/$', params: { pluginId: 'queue', _splat: 'list' } },
          }),
          expect.objectContaining({ label: 'Queue history' }),
          expect.objectContaining({
            label: 'Settings',
            target: { to: '/settings/$pluginId', params: { pluginId: 'queue' } },
          }),
        ],
      },
      expect.objectContaining({ kind: 'link', label: 'Quotes', disabled: false }),
    ]);
  });

  it('shows mods only their pages and never settings', () => {
    const nav = buildPluginNav(
      map(pluginInfo('queue'), pluginInfo('twitch', { hasPanel: false, panel: undefined })),
      known(queue),
      'mod',
    );
    expect(nav).toEqual([expect.objectContaining({ kind: 'link', label: 'Queue' })]);
  });

  it('greys out stopped plugins and offers settings of unknown plugins to owners', () => {
    const stopped: PluginInfo = pluginInfo('queue', {
      state: 'disabled',
      enabled: false,
      panel: undefined,
    });
    const unknown = pluginInfo('twitch', {
      state: 'disabled',
      hasPanel: false,
      hasSettings: undefined,
      panel: undefined,
    });
    const nav = buildPluginNav(map(stopped, unknown), known(queue), 'owner');
    expect(nav.map((entry) => [entry.label, entry.disabled])).toEqual([
      ['Queue', true],
      ['Twitch', true],
    ]);
    expect(nav[1]).toMatchObject({ kind: 'group', items: [{ label: 'Settings' }] });
    expect(buildPluginNav(map(unknown), new Map(), 'mod')).toEqual([]);
  });
});

describe('healthOf', () => {
  it('flags enabled plugins that failed or degraded', () => {
    expect(healthOf(map(pluginInfo('a'))).tone).toBe('ok');
    expect(healthOf(map(pluginInfo('a', { state: 'disabled', enabled: false }))).tone).toBe('idle');
    const health = healthOf(
      map(pluginInfo('a', { degraded: true }), pluginInfo('b', { state: 'failed', error: 'x' })),
    );
    expect(health.tone).toBe('danger');
    expect(health.problems.map((plugin) => plugin.id)).toEqual(['a', 'b']);
  });
});
