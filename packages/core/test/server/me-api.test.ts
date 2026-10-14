import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract, definePlugin } from '@petalbot/sdk';
import { createTestServer } from './helpers.ts';
import { modUser, ownerUser } from './fixtures.ts';

const layout = {
  name: 'Live',
  columns: [{ width: 1, widgets: [{ id: 'w1', plugin: 'queue', widget: 'list' }] }],
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
          { width: 1, widgets: [{ id: 'same', plugin: 'q', widget: 'w' }] },
          { width: 1, widgets: [{ id: 'same', plugin: 'q', widget: 'w' }] },
        ],
      },
      { name: 'x', columns: [{ width: 1, widgets: [{ plugin: 'q', widget: 'w' }] }] },
      { name: 'x', columns: [{ width: 1, widgets: [{ id: '', plugin: 'q', widget: 'w' }] }] },
      {
        name: 'x',
        columns: [
          {
            width: 1,
            widgets: [{ id: 'big', plugin: 'q', widget: 'w', config: { text: 'x'.repeat(9000) } }],
          },
        ],
      },
    ];
    for (const body of cases) {
      const response = await server.request('/api/me/presets', { method: 'POST', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    await server.close();
  });

  it('allows the same widget several times with different instance ids', async () => {
    const server = await createTestServer();
    const response = await server.request('/api/me/presets', {
      method: 'POST',
      body: {
        name: 'Twice',
        columns: [
          {
            width: 1,
            widgets: [
              { id: 'a', plugin: 'queue', widget: 'list', config: { size: 1 } },
              { id: 'b', plugin: 'queue', widget: 'list', config: { size: 2 } },
            ],
          },
        ],
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      columns: [
        {
          widgets: [
            { id: 'a', config: { size: 1 } },
            { id: 'b', config: { size: 2 } },
          ],
        },
      ],
    });
    await server.close();
  });

  it('validates widget configs of known plugins and keeps unknown ones', async () => {
    const counterContract = defineContract({
      id: 'counter',
      version: '1.0.0',
      widgets: { value: { config: z.object({ counter: z.string().min(1) }) } },
    });
    const server = await createTestServer({
      definitions: { counter: definePlugin(counterContract, { setup: () => undefined }) },
    });
    await server.services.manager.enable('counter');
    const bad = await server.request('/api/me/presets', {
      method: 'POST',
      body: {
        name: 'x',
        columns: [
          {
            width: 1,
            widgets: [{ id: 'a', plugin: 'counter', widget: 'value', config: { counter: '' } }],
          },
        ],
      },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: {
        code: 'validation',
        issues: [{ path: ['columns', 0, 'widgets', 0, 'config', 'counter'] }],
      },
    });
    expect(server.services.users.presets(ownerUser.id)).toEqual([]);
    const unknown = await server.request('/api/me/presets', {
      method: 'POST',
      body: {
        name: 'x',
        columns: [
          {
            width: 1,
            widgets: [{ id: 'a', plugin: 'gone', widget: 'w', config: { anything: 1 } }],
          },
        ],
      },
    });
    expect(unknown.status).toBe(201);
    await server.close();
  });

  it('accepts stored configs that no longer parse, but validates changed ones', async () => {
    const counterContract = defineContract({
      id: 'counter',
      version: '1.0.0',
      widgets: { value: { config: z.object({ counter: z.string().min(1) }) } },
    });
    const server = await createTestServer({
      definitions: { counter: definePlugin(counterContract, { setup: () => undefined }) },
    });
    await server.services.manager.enable('counter');
    // Stored before the plugin's schema changed: both configs are now invalid.
    const broken = (id: string) => ({ id, plugin: 'counter', widget: 'value', config: {} });
    const preset = server.services.users.createPreset(ownerUser.id, {
      name: 'Live',
      columns: [{ width: 1, widgets: [broken('a'), broken('b')] }],
    });
    const fixA = await server.request(`/api/me/presets/${preset.id}`, {
      method: 'PUT',
      body: {
        name: 'Renamed',
        columns: [
          {
            width: 1,
            widgets: [{ ...broken('a'), config: { counter: 'x' } }, broken('b')],
          },
        ],
      },
    });
    expect(fixA.status).toBe(200);
    const stillBad = await server.request(`/api/me/presets/${preset.id}`, {
      method: 'PUT',
      body: {
        name: 'Renamed',
        columns: [
          { width: 1, widgets: [broken('a'), { ...broken('b'), config: { counter: '' } }] },
        ],
      },
    });
    expect(stillBad.status).toBe(400);
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
