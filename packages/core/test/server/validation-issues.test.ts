import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';
import { alertsPlugin } from './fixtures.ts';

describe('validation issues', () => {
  it('lists zod issues of settings and request bodies', async () => {
    const server = await createTestServer({ definitions: { alerts: alertsPlugin() } });
    const settings = await server.request('/api/plugins/alerts/settings', {
      method: 'PATCH',
      body: { volume: 500 },
    });
    expect(settings.status).toBe(400);
    expect(await settings.json()).toEqual({
      error: {
        code: 'validation',
        message: expect.stringContaining('volume') as string,
        issues: [{ path: ['volume'], message: expect.any(String) as string }],
      },
    });
    const preset = await server.request('/api/me/presets', {
      method: 'POST',
      body: { name: '', columns: [] },
    });
    const body = (await preset.json()) as { error: { issues: { path: unknown[] }[] } };
    expect(body.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([['name'], ['columns']]),
    );
    await server.close();
  });
});
