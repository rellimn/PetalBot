import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import {
  availableWidgets,
  bundlesSettled,
  newInstance,
  starterPreset,
} from '../src/dashboard/widgets.ts';
import type { PanelState } from '../src/plugins/registry.ts';
import { pluginInfo } from './harness.tsx';

const Widget = () => null;
const queue = definePanel(
  defineContract({ id: 'queue', version: '1.0.0', widgets: { list: {}, stats: {} } }),
  {
    widgets: {
      list: { title: 'Queue', minRole: 'mod', component: Widget },
      stats: { title: 'Queue stats', component: Widget },
    },
  },
);
const timer = definePanel(
  defineContract({ id: 'timer', version: '1.0.0', widgets: { clock: {} } }),
  {
    widgets: { clock: { title: 'Timer', minRole: 'mod', component: Widget } },
  },
);
const panels = new Map<string, PanelState>([
  ['timer', { status: 'ready', entry: '/t', panel: timer }],
  ['queue', { status: 'ready', entry: '/q', panel: queue }],
  ['broken', { status: 'error', entry: '/b', message: 'x' }],
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

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
        {
          width: 70,
          widgets: [{ id: expect.any(String) as string, plugin: 'queue', widget: 'list' }],
        },
        {
          width: 30,
          widgets: [{ id: expect.any(String) as string, plugin: 'timer', widget: 'clock' }],
        },
      ],
    });
    expect(starterPreset([]).columns).toEqual([
      { width: 70, widgets: [] },
      { width: 30, widgets: [] },
    ]);
  });

  it('leaves widgets that need configuration out of the starter preset', () => {
    const contract = defineContract({
      id: 'cfg',
      version: '1.0.0',
      widgets: {
        needs: { config: z.object({ x: z.string() }) },
        defaults: { config: z.object({ x: z.string().default('a') }) },
        plain: {},
      },
    });
    const panel = definePanel(contract, {
      widgets: {
        needs: { title: 'Needs', minRole: 'mod', component: () => null },
        defaults: { title: 'Defaults', minRole: 'mod', component: () => null },
        plain: { title: 'Plain', minRole: 'mod', component: () => null },
      },
    });
    const panels = new Map([['cfg', { status: 'ready' as const, entry: 'e', panel }]]);
    const starter = starterPreset(availableWidgets(panels, 'mod'));
    expect(starter.columns.flatMap((column) => column.widgets)).toEqual([
      { id: expect.any(String) as string, plugin: 'cfg', widget: 'defaults', config: {} },
      { id: expect.any(String) as string, plugin: 'cfg', widget: 'plain' },
    ]);
  });

  it('creates unique instance ids without crypto.randomUUID (plain-http pages)', () => {
    // Browsers only offer randomUUID in secure contexts; a LAN panel on http has none.
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const widget = queue.widgets[0];
    if (!widget) throw new Error('fixture');
    const ids = new Set(
      Array.from({ length: 50 }, () => newInstance({ plugin: 'queue', widget: 'list' }, widget).id),
    );
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
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
