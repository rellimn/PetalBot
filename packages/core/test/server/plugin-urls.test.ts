import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin } from '@petalbot/sdk';
import { ORIGIN, createTestServer } from './helpers.ts';

describe('ctx.http.url in a server', () => {
  it("uses the config's publicUrl", async () => {
    const urls: string[] = [];
    const server = await createTestServer({
      definitions: {
        links: definePlugin(defineContract({ id: 'links', version: '1.0.0' }), {
          setup(ctx) {
            urls.push(ctx.http.url('/auth/callback'));
          },
        }),
      },
    });
    const enabled = await server.request('/api/plugins/links/enable', { method: 'POST' });
    expect(enabled.status).toBe(200);
    expect(urls).toEqual([`${ORIGIN}/api/p/links/auth/callback`]);
    await server.close();
  });
});
