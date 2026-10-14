import { describe, expect, it } from 'vitest';
import { definePanel, type PluginInfo } from '@petalbot/ui-sdk';
import { defineContract } from '@petalbot/sdk';
import { PanelRegistry, type RegistryState } from '../src/plugins/registry.ts';
import { pluginInfo } from './harness.tsx';

const quotes = defineContract({ id: 'quotes', version: '1.0.0' });
const panelV1 = definePanel(quotes, {
  pages: [{ path: 'v1', title: 'V1', component: () => null }],
});
const panelV2 = definePanel(quotes, {
  pages: [{ path: 'v2', title: 'V2', component: () => null }],
});

const chatPanel = definePanel(defineContract({ id: 'chat', version: '1.0.0' }), {
  pages: [{ path: 'chat', title: 'Chat', component: () => null }],
});

const plugins = (...infos: PluginInfo[]) => new Map(infos.map((info) => [info.id, info]));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const links = () =>
  [...document.head.querySelectorAll('link[data-petalbot-plugin]')].map((link) =>
    link.getAttribute('href'),
  );

function setup(modules: Record<string, () => Promise<unknown>>) {
  return new PanelRegistry({
    importModule: (url) => modules[url]?.() ?? Promise.reject(new Error(`no module ${url}`)),
  });
}

describe('PanelRegistry', () => {
  it('loads bundles of running plugins and adds their stylesheets', async () => {
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () => Promise.resolve({ default: panelV1 }),
    });
    registry.sync(
      plugins(
        pluginInfo('quotes', {
          panel: { entry: '/plugins/quotes/h1/panel.js', styles: ['/plugins/quotes/h1/panel.css'] },
        }),
        pluginInfo('chat', { state: 'disabled', panel: undefined }),
      ),
    );
    expect(registry.states.get('quotes')?.status).toBe('loading');
    await flush();
    expect(registry.states.get('quotes')).toMatchObject({ status: 'ready', panel: panelV1 });
    expect(registry.states.has('chat')).toBe(false);
    expect(links()).toEqual(['/plugins/quotes/h1/panel.css']);
  });

  it('replaces the bundle and its stylesheets when the plugin is reloaded', async () => {
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () => Promise.resolve({ default: panelV1 }),
      '/plugins/quotes/h2/panel.js': () => Promise.resolve({ default: panelV2 }),
    });
    registry.sync(
      plugins(
        pluginInfo('quotes', {
          panel: { entry: '/plugins/quotes/h1/panel.js', styles: ['/plugins/quotes/h1/panel.css'] },
        }),
      ),
    );
    await flush();
    registry.sync(
      plugins(
        pluginInfo('quotes', {
          panel: { entry: '/plugins/quotes/h2/panel.js', styles: ['/plugins/quotes/h2/panel.css'] },
        }),
      ),
    );
    // The old definition stays visible while the new bundle loads.
    expect(registry.states.get('quotes')).toMatchObject({ status: 'ready', panel: panelV1 });
    await flush();
    expect(registry.states.get('quotes')).toMatchObject({ status: 'ready', panel: panelV2 });
    expect(links()).toEqual(['/plugins/quotes/h2/panel.css']);
  });

  it('drops the bundle when the plugin stops but remembers its definition', async () => {
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () => Promise.resolve({ default: panelV1 }),
    });
    registry.sync(plugins(pluginInfo('quotes')));
    await flush();
    registry.sync(plugins(pluginInfo('quotes', { state: 'disabled', panel: undefined })));
    expect(registry.states.has('quotes')).toBe(false);
    expect(registry.known.get('quotes')).toBe(panelV1);
    registry.sync(plugins());
    expect(registry.known.has('quotes')).toBe(false);
  });

  it('reports bundles that fail to load or export the wrong thing', async () => {
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () => Promise.reject(new Error('network down')),
      '/plugins/chat/h1/panel.js': () => Promise.resolve({ default: { nope: true } }),
    });
    registry.sync(plugins(pluginInfo('quotes'), pluginInfo('chat')));
    await flush();
    expect(registry.states.get('quotes')).toMatchObject({
      status: 'error',
      message: 'network down',
    });
    expect(registry.states.get('chat')).toMatchObject({
      status: 'error',
      message: expect.stringContaining('must default-export definePanel') as string,
    });
  });

  it('ignores an old bundle that finishes after a newer one', async () => {
    let finishOld: (value: unknown) => void = () => undefined;
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      '/plugins/quotes/h2/panel.js': () => Promise.resolve({ default: panelV2 }),
    });
    registry.sync(plugins(pluginInfo('quotes')));
    registry.sync(
      plugins(
        pluginInfo('quotes', { panel: { entry: '/plugins/quotes/h2/panel.js', styles: [] } }),
      ),
    );
    await flush();
    finishOld({ default: panelV1 });
    await flush();
    expect(registry.states.get('quotes')).toMatchObject({ status: 'ready', panel: panelV2 });
  });
  it("publishes one change per step and keeps other plugins' entries", async () => {
    const registry = setup({
      '/plugins/quotes/h1/panel.js': () => Promise.resolve({ default: panelV1 }),
      '/plugins/chat/h1/panel.js': () => Promise.resolve({ default: chatPanel }),
    });
    const changes: RegistryState[] = [];
    registry.state.subscribe((state) => {
      changes.push(state);
    });
    registry.sync(plugins(pluginInfo('quotes'), pluginInfo('chat')));
    await flush();
    // loading quotes, loading chat, ready quotes (with known), ready chat (with known)
    expect(changes).toHaveLength(4);
    expect(changes.at(-1)?.known.size).toBe(2);
    const quotes = registry.states.get('quotes');
    registry.sync(
      plugins(pluginInfo('quotes'), pluginInfo('chat', { state: 'stopping', panel: undefined })),
    );
    expect(changes).toHaveLength(5);
    expect(registry.states.get('quotes')).toBe(quotes);
    expect(registry.states.has('chat')).toBe(false);
    expect(registry.known.has('chat')).toBe(true);
  });
});
