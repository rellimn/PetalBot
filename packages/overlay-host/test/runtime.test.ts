import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { defineOverlay, type OverlayBundleInfo } from '@petalbot/ui-sdk';
import { OverlayRuntime } from '../src/runtime.ts';

const contract = defineContract({
  id: 'alerts',
  version: '1.0.0',
  overlays: { box: { config: z.object({}), events: [], rpc: [] } },
});
const definition = defineOverlay(contract, 'box', { component: () => null });

const bundle = (hash: string, styles: string[] = []): OverlayBundleInfo => ({
  hash,
  entry: `/plugins/alerts/overlays/box/${hash}/box.js`,
  styles: styles.map((style) => `/plugins/alerts/overlays/box/${hash}/${style}`),
});

function setup(module: unknown = { default: definition }) {
  const imported: string[] = [];
  const reload = vi.fn();
  const runtime = new OverlayRuntime({
    pluginId: 'alerts',
    overlay: 'box',
    importModule: (url) => {
      imported.push(url);
      return Promise.resolve(module);
    },
    reload,
  });
  return { runtime, imported, reload };
}

describe('OverlayRuntime', () => {
  it('loads the bundle and its stylesheets once', async () => {
    const { runtime, imported } = setup();
    expect(runtime.view).toEqual({ status: 'waiting' });
    runtime.update(bundle('h1', ['box.css']));
    runtime.update(bundle('h1', ['box.css']));
    await vi.waitFor(() => {
      expect(runtime.view).toEqual({ status: 'ready', definition });
    });
    expect(imported).toEqual(['/plugins/alerts/overlays/box/h1/box.js']);
    const links = [...document.head.querySelectorAll('link[data-petalbot-overlay]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/plugins/alerts/overlays/box/h1/box.css',
    ]);
  });

  it('waits while there is no bundle and shows the loaded code again without importing', async () => {
    const { runtime, imported, reload } = setup();
    runtime.update(bundle('h1'));
    await vi.waitFor(() => {
      expect(runtime.view.status).toBe('ready');
    });
    runtime.update(null);
    expect(runtime.view).toEqual({ status: 'waiting' });
    runtime.update(bundle('h1'));
    expect(runtime.view).toEqual({ status: 'ready', definition });
    expect(imported).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page once when new code arrives', async () => {
    const { runtime, reload } = setup();
    runtime.update(bundle('h1'));
    await vi.waitFor(() => {
      expect(runtime.view.status).toBe('ready');
    });
    runtime.update(bundle('h2'));
    runtime.update(bundle('h3'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('fails on bundles that are not this overlay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runtime } = setup({ default: { kind: 'petalbot.panel' } });
    runtime.update(bundle('h1'));
    await vi.waitFor(() => {
      expect(runtime.view).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('defineOverlay') as string,
      });
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
