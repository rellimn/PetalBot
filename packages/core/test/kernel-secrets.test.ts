import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  ValidationError,
  defineContract,
  definePlugin,
  type PluginContext,
} from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { openDatabase } from '../src/storage/database.ts';
import { createStorage } from '../src/storage/storage.ts';
import { createMemoryLogger } from './helpers.ts';

const Token = z.object({ accessToken: z.string(), expiresAt: z.number().nullable() });
const vaultContract = defineContract({
  id: 'vault',
  version: '1.0.0',
  secrets: {
    apiKey: { userSettable: true, label: 'API key', description: 'From the vendor' },
    webhook: { userSettable: true, label: 'Webhook secret' },
    plain: {},
    tokens: { schema: Token, keyed: true },
    tokensOld: { keyed: true },
  },
});
type VaultCtx = PluginContext<typeof vaultContract, [], []>;

function setup() {
  const storage = createStorage(openDatabase(':memory:'), randomBytes(32));
  const logger = createMemoryLogger();
  const kernel = new Kernel({ logger, storage, listenerTimeoutMs: 50 });
  return { storage, kernel, logger };
}

async function startVault(kernel: Kernel, onSetup: (ctx: VaultCtx) => void = () => undefined) {
  const holder: { ctx?: VaultCtx } = {};
  const plugin = definePlugin(vaultContract, {
    setup(ctx) {
      holder.ctx = ctx;
      onSetup(ctx);
    },
  });
  await kernel.start(plugin);
  if (!holder.ctx) throw new Error('vault did not start');
  return { ctx: holder.ctx, plugin };
}

describe('ctx.secrets', () => {
  it('round-trips single, schema and keyed secrets', async () => {
    const { kernel } = setup();
    const { ctx } = await startVault(kernel);
    await ctx.secrets.set('plain', 'p-1');
    await ctx.secrets.set('tokens', 'b', { accessToken: 'tok-b', expiresAt: null });
    await ctx.secrets.set('tokens', 'a/1', { accessToken: 'tok-a', expiresAt: 5 });
    await ctx.secrets.set('tokensOld', 'x', 'old');
    expect(await ctx.secrets.get('plain')).toBe('p-1');
    expect(await ctx.secrets.get('tokens', 'a/1')).toEqual({ accessToken: 'tok-a', expiresAt: 5 });
    expect(await ctx.secrets.get('tokens', 'missing')).toBeUndefined();
    expect(await ctx.secrets.keys('tokens')).toEqual(['a/1', 'b']);
    expect(await ctx.secrets.keys('tokensOld')).toEqual(['x']);
    await ctx.secrets.delete('tokens', 'b');
    expect(await ctx.secrets.keys('tokens')).toEqual(['a/1']);
    await ctx.secrets.delete('plain');
    expect(await ctx.secrets.get('plain')).toBeUndefined();
  });

  it('encrypts schema values as JSON under <name>/<key>', async () => {
    const { kernel, storage } = setup();
    const { ctx } = await startVault(kernel);
    await ctx.secrets.set('tokens', '42', { accessToken: 'very-secret', expiresAt: null });
    expect(storage.secrets.names('vault')).toEqual(['tokens/42']);
    expect(storage.secrets.get('vault', 'tokens/42')).toBe(
      '{"accessToken":"very-secret","expiresAt":null}',
    );
    const raw = storage.sqlite.prepare('SELECT * FROM petalbot_secrets').all();
    expect(JSON.stringify(raw)).not.toContain('very-secret');
  });

  it('refuses undeclared names, wrong keys and wrong values', async () => {
    const { kernel } = setup();
    const { ctx } = await startVault(kernel);
    const loose = ctx.secrets as unknown as {
      get(name: string, key?: unknown): Promise<unknown>;
      set(name: string, ...args: unknown[]): Promise<void>;
    };
    await expect(loose.get('nope')).rejects.toThrow(AccessError);
    await expect(loose.get('nope')).rejects.toThrow('Plugin "vault" declares no secret "nope"');
    await expect(loose.get('tokens')).rejects.toThrow(
      'Secret "tokens" of plugin "vault" is keyed: pass a key of 1 to 128 characters',
    );
    await expect(loose.get('tokens', '')).rejects.toThrow(TypeError);
    await expect(loose.get('tokens', 'k'.repeat(129))).rejects.toThrow(TypeError);
    await expect(loose.get('plain', 'k')).rejects.toThrow(
      'Secret "plain" of plugin "vault" is not keyed',
    );
    await expect(loose.set('plain', 42)).rejects.toThrow(
      'Secret "plain" of plugin "vault" must be a string',
    );
    const invalid = loose.set('tokens', 'k', { accessToken: 'hush-value', expiresAt: 'soon' });
    await expect(invalid).rejects.toThrow(ValidationError);
    await expect(
      loose.set('tokens', 'k', { accessToken: 'hush-value', expiresAt: 'soon' }),
    ).rejects.not.toThrow(/hush-value/);
  });

  it('reports a corrupt stored value without quoting it', async () => {
    const { kernel, storage } = setup();
    const { ctx } = await startVault(kernel);
    storage.secrets.set('vault', 'tokens/a', '{oops-hush-value');
    const read = ctx.secrets.get('tokens', 'a');
    await expect(read).rejects.toThrow(
      'Stored secret "tokens" of plugin "vault" is not valid JSON',
    );
    await expect(ctx.secrets.get('tokens', 'a')).rejects.not.toThrow(/oops-hush-value/);
  });

  it('calls onChange after plugin and panel writes, with the key for keyed secrets', async () => {
    const { kernel } = setup();
    const calls: string[] = [];
    const { ctx, plugin } = await startVault(kernel, (c) => {
      c.secrets.onChange('apiKey', async () => {
        calls.push(`apiKey=${String(await c.secrets.get('apiKey'))}`);
      });
      c.secrets.onChange('tokens', (key) => {
        calls.push(`tokens:${key}`);
      });
    });
    await ctx.secrets.set('tokens', '7', { accessToken: 'a', expiresAt: null });
    await ctx.secrets.delete('tokens', '7');
    await kernel.secrets(plugin).setUserValue('apiKey', 'k-1');
    await kernel.secrets(plugin).deleteUserValue('apiKey');
    expect(calls).toEqual(['tokens:7', 'tokens:7', 'apiKey=k-1', 'apiKey=undefined']);
  });

  it('stops calling a disposed listener and survives a failing one', async () => {
    const { kernel, logger } = setup();
    const calls: string[] = [];
    const { ctx, plugin } = await startVault(kernel);
    const dispose = ctx.secrets.onChange('plain', () => {
      calls.push('first');
    });
    ctx.secrets.onChange('plain', () => {
      throw new Error('listener broke');
    });
    await ctx.secrets.set('plain', 'a');
    dispose();
    await ctx.secrets.set('plain', 'b');
    expect(calls).toEqual(['first']);
    expect(kernel.secrets(plugin).get('plain', undefined)).toBe('b');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Secret listener failed',
        data: expect.objectContaining({ plugin: 'vault', error: 'listener broke' }) as object,
      }),
    );
  });

  it('does not call listeners of a stopped plugin, only those of the restarted one', async () => {
    const { kernel } = setup();
    const calls: string[] = [];
    const first = await startVault(kernel, (c) => {
      c.secrets.onChange('apiKey', () => {
        calls.push('old');
      });
    });
    await kernel.stop('vault');
    await kernel.secrets(first.plugin).setUserValue('apiKey', 'while-stopped');
    expect(calls).toEqual([]);
    await startVault(kernel, (c) => {
      c.secrets.onChange('apiKey', () => {
        calls.push('new');
      });
    });
    await kernel.secrets(first.plugin).setUserValue('apiKey', 'after-restart');
    expect(calls).toEqual(['new']);
  });
});

describe('Kernel.secrets (panel side)', () => {
  it('lists user-settable secrets with their state, never the values', async () => {
    const { kernel } = setup();
    const { ctx, plugin } = await startVault(kernel);
    await ctx.secrets.set('apiKey', 'k-1');
    await ctx.secrets.set('plain', 'internal');
    expect(kernel.secrets(plugin).status()).toEqual([
      { name: 'apiKey', label: 'API key', description: 'From the vendor', set: true },
      { name: 'webhook', label: 'Webhook secret', set: false },
    ]);
  });

  it('trims panel writes and deletes on an empty value', async () => {
    const { kernel } = setup();
    const { ctx, plugin } = await startVault(kernel);
    const secrets = kernel.secrets(plugin);
    expect(await secrets.setUserValue('apiKey', '  k-2\n')).toEqual({
      name: 'apiKey',
      label: 'API key',
      description: 'From the vendor',
      set: true,
    });
    expect(await ctx.secrets.get('apiKey')).toBe('k-2');
    expect(await secrets.setUserValue('apiKey', ' \n\t ')).toMatchObject({ set: false });
    expect(await ctx.secrets.get('apiKey')).toBeUndefined();
  });

  it('refuses panel writes to internal or undeclared secrets', async () => {
    const { kernel } = setup();
    const { ctx, plugin } = await startVault(kernel);
    const secrets = kernel.secrets(plugin);
    expect(await secrets.setUserValue('plain', 'x')).toBeUndefined();
    expect(await secrets.setUserValue('nope', 'x')).toBeUndefined();
    expect(await secrets.deleteUserValue('tokens')).toBeUndefined();
    expect(await ctx.secrets.get('plain')).toBeUndefined();
  });

  it('works for a plugin that is not running', async () => {
    const { kernel } = setup();
    const plugin = definePlugin(vaultContract, { setup: () => undefined });
    await kernel.secrets(plugin).setUserValue('webhook', 'w-1');
    expect(kernel.secrets(plugin).status()).toContainEqual(
      expect.objectContaining({ name: 'webhook', set: true }),
    );
  });
});
