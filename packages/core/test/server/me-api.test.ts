import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.ts';
import { modUser, ownerUser } from './fixtures.ts';

const layout = {
  name: 'Live',
  columns: [{ width: 1, widgets: [{ plugin: 'queue', widget: 'list' }] }],
};

describe('/api/me/preferences', () => {
  it('reads defaults and replaces them, per user', async () => {
    const server = await createTestServer();
    const initial = await server.request('/api/me/preferences', { as: modUser });
    expect(await initial.json()).toMatchObject({ darkScheme: 'rose', mode: 'system' });
    const saved = await server.request('/api/me/preferences', {
      method: 'PUT',
      as: modUser,
      body: { darkScheme: 'lavender', lightScheme: 'cream', mode: 'dark', density: 'compact' },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      darkScheme: 'lavender',
      lightScheme: 'cream',
      mode: 'dark',
      density: 'compact',
      activePreset: null,
    });
    const owner = await server.request('/api/me/preferences', { as: ownerUser });
    expect(await owner.json()).toMatchObject({ darkScheme: 'rose' });
    await server.close();
  });

  it('rejects unknown schemes and presets of other users', async () => {
    const server = await createTestServer();
    const badScheme = await server.request('/api/me/preferences', {
      method: 'PUT',
      body: { darkScheme: 'neon' },
    });
    expect(badScheme.status).toBe(400);
    const theirs = server.services.users.createPreset(modUser.id, layout);
    const foreign = await server.request('/api/me/preferences', {
      method: 'PUT',
      body: { activePreset: theirs.id },
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: { code: 'validation' } });
    expect((await server.request('/api/me/preferences', { as: 'anonymous' })).status).toBe(401);
    await server.close();
  });
});

describe('/api/me/presets', () => {
  it('creates, lists, replaces and deletes the own presets', async () => {
    const server = await createTestServer();
    const created = await server.request('/api/me/presets', {
      method: 'POST',
      as: modUser,
      body: layout,
    });
    expect(created.status).toBe(201);
    const preset = (await created.json()) as { id: string; name: string };
    expect(preset.name).toBe('Live');

    const list = await server.request('/api/me/presets', { as: modUser });
    expect(await list.json()).toEqual({ presets: [expect.objectContaining({ id: preset.id })] });
    const ownerList = await server.request('/api/me/presets');
    expect(await ownerList.json()).toEqual({ presets: [] });

    const replaced = await server.request(`/api/me/presets/${preset.id}`, {
      method: 'PUT',
      as: modUser,
      body: { ...layout, name: 'Chill' },
    });
    expect(await replaced.json()).toMatchObject({ id: preset.id, name: 'Chill' });
    const notMine = await server.request(`/api/me/presets/${preset.id}`, {
      method: 'PUT',
      body: layout,
    });
    expect(notMine.status).toBe(404);

    expect(
      (await server.request(`/api/me/presets/${preset.id}`, { method: 'DELETE', as: modUser }))
        .status,
    ).toBe(204);
    expect(
      (await server.request(`/api/me/presets/${preset.id}`, { method: 'DELETE', as: modUser }))
        .status,
    ).toBe(404);
    await server.close();
  });

  it('validates layouts', async () => {
    const server = await createTestServer();
    const cases = [
      { name: '', columns: layout.columns },
      { name: 'x', columns: [] },
      { name: 'x', columns: [1, 2, 3, 4].map(() => ({ width: 1, widgets: [] })) },
      { name: 'x', columns: [{ width: 0, widgets: [] }] },
      {
        name: 'x',
        columns: [
          { width: 1, widgets: [{ plugin: 'q', widget: 'w' }] },
          { width: 1, widgets: [{ plugin: 'q', widget: 'w' }] },
        ],
      },
    ];
    for (const body of cases) {
      const response = await server.request('/api/me/presets', { method: 'POST', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    await server.close();
  });

  it('answers 409 when the preset limit is reached', async () => {
    const server = await createTestServer();
    for (let index = 0; index < 20; index += 1) {
      server.services.users.createPreset(ownerUser.id, layout);
    }
    const response = await server.request('/api/me/presets', { method: 'POST', body: layout });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
    await server.close();
  });
});
