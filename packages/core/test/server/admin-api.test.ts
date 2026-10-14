import { describe, expect, it } from 'vitest';
import { createTestServer, ORIGIN, type TestServer } from './helpers.ts';
import { alertsPlugin, fanPlugin, modUser, type AlertsApi } from './fixtures.ts';

async function setup(): Promise<{ server: TestServer; alerts: Partial<AlertsApi> }> {
  const alerts: Partial<AlertsApi> = {};
  const server = await createTestServer({
    definitions: {
      alerts: alertsPlugin({
        onSetup: (api) => {
          Object.assign(alerts, api);
        },
      }),
      fan: fanPlugin,
    },
  });
  return { server, alerts };
}

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('plugin API', () => {
  it('lists plugins for mods and requires a login', async () => {
    const { server } = await setup();
    const list = await server.request('/api/plugins', { as: modUser });
    expect(list.status).toBe(200);
    expect(await body(list)).toMatchObject({
      plugins: [
        { id: 'alerts', state: 'disabled' },
        { id: 'fan', state: 'disabled', dependencies: ['alerts'] },
      ],
      problems: [],
    });
    const anonymous = await server.request('/api/plugins', { as: 'anonymous' });
    expect(anonymous.status).toBe(401);
    expect(await body(anonymous)).toEqual({
      error: { code: 'unauthorized', message: 'Login required' },
    });
    await server.close();
  });

  it('keeps lifecycle actions for owners and asks before enabling dependencies', async () => {
    const { server } = await setup();
    const asMod = await server.request('/api/plugins/fan/enable', { method: 'POST', as: modUser });
    expect(asMod.status).toBe(403);
    const unconfirmed = await server.request('/api/plugins/fan/enable', { method: 'POST' });
    expect(unconfirmed.status).toBe(409);
    expect(await body(unconfirmed)).toMatchObject({
      error: { code: 'confirmation_required', plugins: ['alerts'] },
    });
    const confirmed = await server.request('/api/plugins/fan/enable', {
      method: 'POST',
      body: { withDependencies: true },
    });
    expect(confirmed.status).toBe(200);
    expect(await body(confirmed)).toMatchObject({ id: 'fan', state: 'running', enabled: true });
    const reload = await server.request('/api/plugins/alerts/reload', { method: 'POST' });
    expect(reload.status).toBe(200);
    const disable = await server.request('/api/plugins/alerts/disable', {
      method: 'POST',
      body: { withDependents: true },
    });
    expect(await body(disable)).toMatchObject({ id: 'alerts', state: 'disabled' });
    await server.close();
  });

  it('rejects state-changing requests from other origins or without Origin', async () => {
    const { server } = await setup();
    for (const origin of ['https://evil.example', null]) {
      const response = await server.request('/api/plugins/alerts/enable', {
        method: 'POST',
        origin,
      });
      expect(response.status).toBe(403);
    }
    await server.close();
  });

  it('answers unknown plugins, unknown paths and bad bodies with JSON errors', async () => {
    const { server } = await setup();
    const unknown = await server.request('/api/plugins/nope/enable', { method: 'POST' });
    expect(unknown.status).toBe(404);
    const path = await server.request('/api/nothing-here');
    expect(path.status).toBe(404);
    expect(await body(path)).toMatchObject({ error: { code: 'not_found' } });
    const malformed = await server.request('/api/plugins/alerts/enable', {
      method: 'POST',
      rawBody: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.status).toBe(400);
    expect(await body(malformed)).toMatchObject({ error: { code: 'validation' } });
    const tooLarge = await server.request('/api/plugins/alerts/enable', {
      method: 'POST',
      rawBody: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(tooLarge.status).toBe(413);
    await server.close();
  });

  it('deletes plugin data only after confirmation and when disabled', async () => {
    const { server } = await setup();
    await server.request('/api/plugins/alerts/enable', { method: 'POST' });
    await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'box', name: 'Main' },
    });
    const wrongConfirm = await server.request('/api/plugins/alerts/data', {
      method: 'DELETE',
      body: { confirm: 'fan' },
    });
    expect(wrongConfirm.status).toBe(400);
    const stillEnabled = await server.request('/api/plugins/alerts/data', {
      method: 'DELETE',
      body: { confirm: 'alerts' },
    });
    expect(stillEnabled.status).toBe(409);
    await server.request('/api/plugins/alerts/disable', { method: 'POST' });
    const deleted = await server.request('/api/plugins/alerts/data', {
      method: 'DELETE',
      body: { confirm: 'alerts' },
    });
    expect(deleted.status).toBe(200);
    expect(await body(deleted)).toMatchObject({ overlayInstances: 1 });
    expect(server.services.overlays.list()).toEqual([]);
    await server.close();
  });

  it('reads and validates settings, with their JSON Schema', async () => {
    const { server } = await setup();
    const initial = await body(await server.request('/api/plugins/alerts/settings'));
    expect(initial).toMatchObject({
      values: { volume: 50 },
      schema: { type: 'object', properties: { volume: { type: 'number' } } },
    });
    const invalid = await server.request('/api/plugins/alerts/settings', {
      method: 'PATCH',
      body: { volume: 500 },
    });
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toMatchObject({ error: { code: 'validation' } });
    const updated = await server.request('/api/plugins/alerts/settings', {
      method: 'PATCH',
      body: { volume: 70 },
    });
    expect(await body(updated)).toEqual({ values: { volume: 70 } });
    const asMod = await server.request('/api/plugins/alerts/settings', { as: modUser });
    expect(asMod.status).toBe(403);
    await server.close();
  });
});

describe('overlay API', () => {
  it('creates, lists, reconfigures, rotates and revokes overlay instances', async () => {
    const { server } = await setup();
    const stopped = await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'box', name: 'Main' },
    });
    expect(stopped.status).toBe(409);
    expect(await body(await server.request('/api/overlays'))).toEqual({
      instances: [],
      overlays: [],
    });
    await server.request('/api/plugins/alerts/enable', { method: 'POST' });
    const badConfig = await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'box', name: 'Main', config: { durationMs: -1 } },
    });
    expect(badConfig.status).toBe(400);
    expect(await body(badConfig)).toMatchObject({
      error: { code: 'validation', issues: [{ path: ['config', 'durationMs'] }] },
    });
    const noName = await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'box', name: '   ' },
    });
    expect(noName.status).toBe(400);
    const unknown = await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'ticker', name: 'Main' },
    });
    expect(unknown.status).toBe(404);

    const created = await server.request('/api/overlays', {
      method: 'POST',
      body: { pluginId: 'alerts', overlay: 'box', name: ' Main ', config: { durationMs: 3000 } },
    });
    expect(created.status).toBe(201);
    const { instance, token, url } = (await created.json()) as {
      instance: { id: string; name: string; config: unknown };
      token: string;
      url: string;
    };
    expect(instance).toMatchObject({ name: 'Main', config: { durationMs: 3000 } });
    expect(url).toBe(`${ORIGIN}/overlay/alerts/box/${instance.id}?t=${token}`);
    expect(server.services.overlays.findByToken(token)?.id).toBe(instance.id);

    const list = await body(await server.request('/api/overlays'));
    expect(list).toEqual({
      instances: [expect.objectContaining({ id: instance.id, name: 'Main' })],
      overlays: [
        {
          pluginId: 'alerts',
          overlay: 'box',
          schema: expect.objectContaining({ type: 'object' }) as object,
          hasBundle: false,
        },
      ],
    });
    expect(JSON.stringify(list)).not.toContain(token);

    const patched = await server.request(`/api/overlays/${instance.id}`, {
      method: 'PATCH',
      body: { name: 'Gaming', config: { durationMs: 1000 } },
    });
    expect(await body(patched)).toMatchObject({ name: 'Gaming', config: { durationMs: 1000 } });
    const empty = await server.request(`/api/overlays/${instance.id}`, {
      method: 'PATCH',
      body: {},
    });
    expect(empty.status).toBe(400);
    const invalid = await server.request(`/api/overlays/${instance.id}`, {
      method: 'PATCH',
      body: { config: { durationMs: 0 } },
    });
    expect(await body(invalid)).toMatchObject({
      error: { code: 'validation', issues: [{ path: ['config', 'durationMs'] }] },
    });

    await server.request('/api/plugins/alerts/disable', { method: 'POST' });
    const renamedWhileStopped = await server.request(`/api/overlays/${instance.id}`, {
      method: 'PATCH',
      body: { name: 'Stopped' },
    });
    expect(await body(renamedWhileStopped)).toMatchObject({ name: 'Stopped' });
    const configWhileStopped = await server.request(`/api/overlays/${instance.id}`, {
      method: 'PATCH',
      body: { config: { durationMs: 2000 } },
    });
    expect(configWhileStopped.status).toBe(409);

    const rotated = (await (
      await server.request(`/api/overlays/${instance.id}/rotate`, { method: 'POST' })
    ).json()) as { token: string };
    expect(rotated.token).not.toBe(token);
    expect(server.services.overlays.findByToken(token)).toBeUndefined();

    const revoked = await server.request(`/api/overlays/${instance.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(204);
    const again = await server.request(`/api/overlays/${instance.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect((await server.request('/api/overlays', { as: modUser })).status).toBe(403);
    await server.close();
  });
});

describe('event log API', () => {
  it('pages through recent events for owners', async () => {
    const { server, alerts } = await setup();
    await server.request('/api/plugins/alerts/enable', { method: 'POST' });
    alerts.shown?.('one');
    alerts.internal?.();
    const page = await body(await server.request('/api/events?limit=1'));
    expect(page).toMatchObject({ events: [{ name: 'alerts.internal', source: 'alerts' }] });
    const invalid = await server.request('/api/events?limit=0');
    expect(invalid.status).toBe(400);
    expect((await server.request('/api/events', { as: modUser })).status).toBe(403);
    await server.close();
  });
});

describe('plugin routes', () => {
  it('forwards to ctx.http routes with their own auth rules', async () => {
    const { server } = await setup();
    const stopped = await server.request('/api/p/alerts/webhook', { method: 'POST' });
    expect(stopped.status).toBe(404);
    expect(await body(stopped)).toMatchObject({ error: { code: 'unavailable' } });
    await server.request('/api/plugins/alerts/enable', { method: 'POST' });

    const webhook = await server.request('/api/p/alerts/webhook', {
      method: 'POST',
      as: 'anonymous',
      origin: null,
      rawBody: 'hi',
    });
    expect(await body(webhook)).toEqual({ got: 'hi' });
    expect((await server.request('/api/p/alerts/secret', { as: modUser })).status).toBe(403);
    expect((await server.request('/api/p/alerts/secret')).status).toBe(200);
    expect((await server.request('/api/p/alerts/secret', { as: 'anonymous' })).status).toBe(401);
    const crossSite = await server.request('/api/p/alerts/save', {
      method: 'POST',
      origin: 'https://evil.example',
    });
    expect(crossSite.status).toBe(403);
    expect((await server.request('/api/p/alerts/save', { method: 'POST' })).status).toBe(200);
    await server.close();
  });
});
