import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';
import { alertsPlugin, modUser } from './fixtures.ts';

async function setup() {
  const server = await createTestServer({
    definitions: { alerts: alertsPlugin() },
    panels: {
      alerts: {
        entry: 'dist/panel/panel.js',
        overlays: { box: 'dist/overlays/box/box.js' },
        files: {
          'dist/panel/panel.js': 'export default {};',
          'dist/panel/panel.css': '.box{}',
          'dist/panel/assets/logo.svg': '<svg/>',
          'dist/overlays/box/box.js': 'export default "box";',
          'dist/overlays/box/box.css': '.overlay{}',
        },
      },
    },
  });
  await server.request('/api/plugins/alerts/enable', { method: 'POST' });
  const hash = server.services.manager.panelSnapshot('alerts')?.hash ?? 'missing';
  const overlayHash = server.services.manager.overlaySnapshot('alerts', 'box')?.hash ?? 'missing';
  return {
    server,
    base: `/plugins/alerts/${hash}`,
    overlayBase: `/plugins/alerts/overlays/box/${overlayHash}`,
  };
}

describe('plugin bundle files', () => {
  it('serves the current panel bundle to panel sessions with long-lived caching', async () => {
    const { server, base } = await setup();
    const js = await server.request(`${base}/panel.js`, { as: modUser });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await js.text()).toBe('export default {};');
    const css = await server.request(`${base}/panel.css`);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const svg = await server.request(`${base}/assets/logo.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    const plugins = (await (await server.request('/api/plugins')).json()) as {
      plugins: { id: string; panel?: unknown; hasPanel: boolean }[];
    };
    expect(plugins.plugins[0]).toMatchObject({
      id: 'alerts',
      hasPanel: true,
      panel: { entry: `${base}/panel.js`, styles: [`${base}/panel.css`] },
    });
    await server.close();
  });

  it('serves the snapshot taken at start, not what is on disk now', async () => {
    const { server, base, overlayBase } = await setup();
    await writeFile(join(server.root, 'alerts/dist/panel/panel.js'), 'export default "new";');
    await writeFile(join(server.root, 'alerts/dist/overlays/box/box.js'), 'export default "new";');
    expect(await (await server.request(`${base}/panel.js`)).text()).toBe('export default {};');
    expect(await (await server.request(`${overlayBase}/box.js`)).text()).toBe(
      'export default "box";',
    );
    await server.request('/api/plugins/alerts/reload', { method: 'POST' });
    expect((await server.request(`${base}/panel.js`)).status).toBe(404);
    const fresh = server.services.manager.panelSnapshot('alerts')?.hash ?? '';
    expect(await (await server.request(`/plugins/alerts/${fresh}/panel.js`)).text()).toBe(
      'export default "new";',
    );
    await server.close();
  });

  it('serves overlay bundles without a session, publicly cacheable', async () => {
    const { server, overlayBase } = await setup();
    const js = await server.request(`${overlayBase}/box.js`, { as: 'anonymous', origin: null });
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await js.text()).toBe('export default "box";');
    expect((await server.request(`${overlayBase}/box.css`, { as: 'anonymous' })).status).toBe(200);
    expect(server.services.manager.overlayBundle('alerts', 'box')).toEqual({
      hash: overlayBase.split('/').at(-1),
      entry: `${overlayBase}/box.js`,
      styles: [`${overlayBase}/box.css`],
    });
    await server.close();
  });

  it('refuses anonymous panel requests, old hashes, stopped plugins and escapes', async () => {
    const { server, base, overlayBase } = await setup();
    expect((await server.request(`${base}/panel.js`, { as: 'anonymous' })).status).toBe(401);
    expect((await server.request('/plugins/alerts/0000000000000000/panel.js')).status).toBe(404);
    expect(
      (await server.request('/plugins/alerts/overlays/box/0000000000000000/box.js')).status,
    ).toBe(404);
    expect((await server.request('/plugins/alerts/overlays/nope/x/box.js')).status).toBe(404);
    expect((await server.request(`${base}/nope.js`)).status).toBe(404);
    expect((await server.request(`${base}/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await server.request(`${overlayBase}/..%2F..%2Fpanel%2Fpanel.js`)).status).toBe(404);
    expect((await server.request(`${base}/assets`)).status).toBe(404);
    await server.request('/api/plugins/alerts/disable', { method: 'POST' });
    expect((await server.request(`${base}/panel.js`)).status).toBe(404);
    expect((await server.request(`${overlayBase}/box.js`, { as: 'anonymous' })).status).toBe(404);
    await server.close();
  });

  it('does not serve files that symbolic links in a bundle point to', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'petalbot-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    const server = await createTestServer({
      definitions: { alerts: alertsPlugin() },
      panels: { alerts: { entry: 'dist/panel/panel.js', files: { 'dist/panel/panel.js': '' } } },
    });
    await symlink(join(outside, 'secret.txt'), join(server.root, 'alerts/dist/panel/leak.txt'));
    await server.request('/api/plugins/alerts/enable', { method: 'POST' });
    const hash = server.services.manager.panelSnapshot('alerts')?.hash ?? '';
    expect((await server.request(`/plugins/alerts/${hash}/leak.txt`)).status).toBe(404);
    await server.close();
  });
});
