import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin } from '@petalbot/sdk';
import type { MemoryLogger } from '../helpers.ts';
import { modUser } from './fixtures.ts';
import { createTestServer } from './helpers.ts';

const vaultContract = defineContract({
  id: 'vault',
  version: '1.0.0',
  secrets: {
    apiKey: { userSettable: true, label: 'API key', description: 'From the vendor' },
    webhook: { userSettable: true, label: 'Webhook secret' },
    tokens: { keyed: true },
  },
});

function vaultPlugin(changes: string[] = []) {
  return definePlugin(vaultContract, {
    setup(ctx) {
      ctx.secrets.onChange('apiKey', async () => {
        changes.push(`apiKey=${String(await ctx.secrets.get('apiKey'))}`);
      });
    },
  });
}

const VALUE = 'sk-live-0123456789';
const apiKey = { name: 'apiKey', label: 'API key', description: 'From the vendor' };
const put = (value: unknown) => ({ method: 'PUT', body: { value } });

describe('secrets API', () => {
  it('lists user-settable secrets without values, also for stopped plugins', async () => {
    const server = await createTestServer({ definitions: { vault: vaultPlugin() } });
    const list = await server.request('/api/plugins/vault/secrets');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      secrets: [
        { ...apiKey, set: false },
        { name: 'webhook', label: 'Webhook secret', set: false },
      ],
    });
    await server.close();
  });

  it('stores a trimmed value, notifies the running plugin and never echoes the value', async () => {
    const changes: string[] = [];
    const server = await createTestServer({ definitions: { vault: vaultPlugin(changes) } });
    await server.request('/api/plugins/vault/enable', { method: 'POST' });
    const saved = await server.request('/api/plugins/vault/secrets/apiKey', put(`  ${VALUE}\n`));
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(JSON.parse(savedText)).toEqual({ ...apiKey, set: true });
    expect(savedText).not.toContain(VALUE);
    expect(changes).toEqual([`apiKey=${VALUE}`]);
    const listText = await (await server.request('/api/plugins/vault/secrets')).text();
    expect(listText).not.toContain(VALUE);
    expect(JSON.stringify((server.services.logger as MemoryLogger).entries)).not.toContain(VALUE);
    await server.close();
  });

  it('deletes on a whitespace-only value and on DELETE', async () => {
    const server = await createTestServer({ definitions: { vault: vaultPlugin() } });
    await server.request('/api/plugins/vault/secrets/apiKey', put(VALUE));
    const blank = await server.request('/api/plugins/vault/secrets/apiKey', put(' \n\t'));
    expect(await blank.json()).toEqual({ ...apiKey, set: false });
    await server.request('/api/plugins/vault/secrets/webhook', put('w-1'));
    const deleted = await server.request('/api/plugins/vault/secrets/webhook', {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect(await (await server.request('/api/plugins/vault/secrets')).json()).toEqual({
      secrets: [
        { ...apiKey, set: false },
        { name: 'webhook', label: 'Webhook secret', set: false },
      ],
    });
    await server.close();
  });

  it('answers 404 for internal and unknown secrets, 400 for bad bodies, 403 for mods', async () => {
    const server = await createTestServer({ definitions: { vault: vaultPlugin() } });
    const internal = await server.request('/api/plugins/vault/secrets/tokens', put('x'));
    expect(internal.status).toBe(404);
    expect(await internal.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Plugin "vault" has no user-settable secret "tokens"',
      },
    });
    const unknown = await server.request('/api/plugins/vault/secrets/nope', { method: 'DELETE' });
    expect(unknown.status).toBe(404);
    const plugin = await server.request('/api/plugins/nope/secrets');
    expect(plugin.status).toBe(404);
    const notString = await server.request('/api/plugins/vault/secrets/apiKey', put(42));
    expect(notString.status).toBe(400);
    const tooLong = await server.request(
      '/api/plugins/vault/secrets/apiKey',
      put('x'.repeat(16_385)),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).not.toContain('xxxxxxxx');
    const asMod = await server.request('/api/plugins/vault/secrets', { as: modUser });
    expect(asMod.status).toBe(403);
    const modWrite = await server.request('/api/plugins/vault/secrets/apiKey', {
      ...put('x'),
      as: modUser,
    });
    expect(modWrite.status).toBe(403);
    await server.close();
  });

  it('marks a plugin with user-settable secrets as having settings', async () => {
    const server = await createTestServer({ definitions: { vault: vaultPlugin() } });
    await server.request('/api/plugins/vault/enable', { method: 'POST' });
    const list = (await (await server.request('/api/plugins')).json()) as {
      plugins: { id: string; hasSettings?: boolean }[];
    };
    expect(list.plugins.find((plugin) => plugin.id === 'vault')?.hasSettings).toBe(true);
    const settings = await server.request('/api/plugins/vault/settings');
    expect(await settings.json()).toEqual({ values: {}, schema: null });
    await server.close();
  });
});
