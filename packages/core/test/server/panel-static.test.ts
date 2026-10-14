import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';

async function builtPanel(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'petalbot-panel-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>PetalBot</title>');
  await writeFile(join(dir, 'assets', 'app-123.js'), 'console.log(1)');
  await writeFile(join(dir, 'favicon.svg'), '<svg/>');
  return dir;
}

describe('serving the built panel', () => {
  it('serves index.html for app routes and files with fitting caching', async () => {
    const server = await createTestServer({ config: { panelDir: await builtPanel() } });
    for (const path of ['/', '/admin/plugins', '/p/quotes/list', '/..%2fpackage.json']) {
      const response = await server.request(path, { as: 'anonymous' });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(await response.text()).toContain('<title>PetalBot</title>');
    }
    const asset = await server.request('/assets/app-123.js', { as: 'anonymous' });
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const favicon = await server.request('/favicon.svg', { as: 'anonymous' });
    expect(favicon.headers.get('content-type')).toBe('image/svg+xml');
    expect(favicon.headers.get('cache-control')).toBe('no-cache');
    await server.close();
  });

  it('answers JSON 404s for missing assets, API paths and other methods', async () => {
    const server = await createTestServer({ config: { panelDir: await builtPanel() } });
    expect((await server.request('/assets/missing.js')).status).toBe(404);
    const api = await server.request('/api/nothing');
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await server.request('/plugins/x/y/z.js')).status).toBe(404);
    expect((await server.request('/', { method: 'POST' })).status).toBe(404);
    await server.close();
  });

  it('explains how to build the panel when it is missing', async () => {
    const server = await createTestServer({ config: { panelDir: '/nonexistent/petalbot-panel' } });
    const response = await server.request('/');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'not_found',
        message: expect.stringContaining('pnpm@12.10.1 build') as string,
      },
    });
    await server.close();
  });
});
