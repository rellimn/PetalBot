import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';

async function builtHost(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'petalbot-overlay-host-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>PetalBot overlay</title>');
  await writeFile(join(dir, 'assets', 'host-1.js'), 'console.log(1)');
  await writeFile(join(dir, 'favicon.svg'), '<svg/>');
  return dir;
}

describe('serving the overlay host', () => {
  it('answers overlay URLs with the host page, framable only by the panel', async () => {
    const server = await createTestServer({ config: { overlayDir: await builtHost() } });
    for (const path of [
      '/overlay/alerts/box/01J0ABC?t=secret',
      '/overlay/my-plugin/quote-box/x?preview',
    ]) {
      const response = await server.request(path, { as: 'anonymous', origin: null });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBeNull();
      expect(await response.text()).toContain('<title>PetalBot overlay</title>');
    }
    await server.close();
  });

  it('serves host assets with fitting caching and refuses everything else', async () => {
    const server = await createTestServer({ config: { overlayDir: await builtHost() } });
    const asset = await server.request('/overlay/_/assets/host-1.js', { as: 'anonymous' });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const favicon = await server.request('/overlay/_/favicon.svg', { as: 'anonymous' });
    expect(favicon.headers.get('cache-control')).toBe('no-cache');
    for (const path of [
      '/overlay/_/index.html',
      '/overlay/_/assets/missing.js',
      '/overlay/_/..%2F..%2Fpackage.json',
      '/overlay/alerts/box',
      '/overlay/Alerts/box/x',
      '/overlay/alerts/box/x/y',
    ]) {
      expect((await server.request(path, { as: 'anonymous' })).status, path).toBe(404);
    }
    await server.close();
  });

  it('explains how to build the host when it is missing', async () => {
    const server = await createTestServer({ config: { overlayDir: '/nonexistent/petalbot-host' } });
    const response = await server.request('/overlay/alerts/box/x?t=1', { as: 'anonymous' });
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
