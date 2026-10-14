import { describe, expect, it } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { availableWidgets, bundlesSettled, starterPreset } from '../src/dashboard/widgets.ts';
import type { PanelState } from '../src/plugins/registry.ts';
import { pluginInfo } from './harness.tsx';

const Widget = () => null;
const queue = definePanel(defineContract({ id: 'queue', version: '1.0.0' }), {
  widgets: [
    { id: 'list', title: 'Queue', minRole: 'mod', component: Widget },
    { id: 'stats', title: 'Queue stats', component: Widget },
  ],
});
const timer = definePanel(defineContract({ id: 'timer', version: '1.0.0' }), {
  widgets: [{ id: 'clock', title: 'Timer', minRole: 'mod', component: Widget }],
});
const panels = new Map<string, PanelState>([
  ['timer', { status: 'ready', entry: '/t', panel: timer }],
  ['queue', { status: 'ready', entry: '/q', panel: queue }],
  ['broken', { status: 'error', entry: '/b', message: 'x' }],
]);

describe('dashboard widgets', () => {
  it('lists the widgets a role may see, by plugin', () => {
    expect(availableWidgets(panels, 'owner').map((widget) => widget.title)).toEqual([
      'Queue',
      'Queue stats',
      'Timer',
    ]);
    expect(availableWidgets(panels, 'mod').map((widget) => widget.ref)).toEqual([
      { plugin: 'queue', widget: 'list' },
      { plugin: 'timer', widget: 'clock' },
    ]);
  });

  it('builds the starter preset: first widget in the main column, the rest at the side', () => {
    expect(starterPreset(availableWidgets(panels, 'mod'))).toEqual({
      name: 'My dashboard',
      columns: [
        { width: 70, widgets: [{ plugin: 'queue', widget: 'list' }] },
        { width: 30, widgets: [{ plugin: 'timer', widget: 'clock' }] },
      ],
    });
    expect(starterPreset([]).columns).toEqual([
      { width: 70, widgets: [] },
      { width: 30, widgets: [] },
    ]);
  });

  it('waits until every running bundle has loaded or failed', () => {
    const plugins = new Map([
      ['queue', pluginInfo('queue')],
      ['timer', pluginInfo('timer')],
    ]);
    expect(bundlesSettled(plugins, new Map([...panels].filter(([id]) => id === 'queue')))).toBe(
      false,
    );
    expect(bundlesSettled(plugins, panels)).toBe(true);
    expect(
      bundlesSettled(
        new Map([['x', pluginInfo('x', { state: 'disabled', panel: undefined })]]),
        new Map(),
      ),
    ).toBe(true);
  });
});
