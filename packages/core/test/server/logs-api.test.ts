import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';
import { modUser } from './fixtures.ts';

describe('GET /api/logs', () => {
  it('pages through the ring with filters, for owners only', async () => {
    const server = await createTestServer();
    const { logs } = server.services;
    logs.push({ time: 1, level: 'info', message: 'core', data: {} });
    logs.push({ time: 2, level: 'debug', message: 'q debug', data: { plugin: 'quotes' } });
    logs.push({ time: 3, level: 'error', message: 'q error', data: { plugin: 'quotes' } });

    const all = (await (await server.request('/api/logs')).json()) as {
      entries: { id: number; message: string }[];
    };
    expect(all.entries.map((entry) => entry.message)).toEqual(['q error', 'q debug', 'core']);

    const filtered = (await (
      await server.request('/api/logs?plugin=quotes&level=info&limit=5')
    ).json()) as { entries: { message: string }[] };
    expect(filtered.entries.map((entry) => entry.message)).toEqual(['q error']);

    const older = (await (await server.request('/api/logs?before=2')).json()) as {
      entries: { message: string }[];
    };
    expect(older.entries.map((entry) => entry.message)).toEqual(['core']);

    expect((await server.request('/api/logs', { as: modUser })).status).toBe(403);
    expect((await server.request('/api/logs?level=loud')).status).toBe(400);
    await server.close();
  });
});
