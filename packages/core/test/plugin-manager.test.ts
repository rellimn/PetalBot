import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin, type AnyPluginDefinition } from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { currentPlugin, runInPlugin } from '../src/plugin-scope.ts';
import { DependencyActionRequired, PluginManager } from '../src/plugin-manager.ts';
import { openDatabase, type Sqlite } from '../src/storage/database.ts';
import { PluginStateStore } from '../src/storage/plugin-state-store.ts';
import { createStorage } from '../src/storage/storage.ts';
import { randomBytes } from 'node:crypto';
import { counterContract, createMemoryLogger, listenerContract } from './helpers.ts';

const brokenContract = defineContract({ id: 'broken', version: '1.0.0' });

async function writeManifest(
  root: string,
  id: string,
  dependencies: Record<string, string> = {},
): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      petalbot: { id, apiVersion: 1, entries: { server: 'server.js' }, dependencies },
    }),
  );
}

async function setup(
  options: { listenerRange?: string; sqlite?: Sqlite; maxBundleBytes?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'petalbot-manager-'));
  await writeManifest(root, 'counter');
  await writeManifest(root, 'listener', { counter: options.listenerRange ?? '^1.0.0' });
  await writeManifest(root, 'broken');
  const calls: string[] = [];
  const loadScopes: (string | undefined)[] = [];
  const definitions: Record<string, AnyPluginDefinition> = {
    counter: definePlugin(
      defineContract({
        ...counterContract,
        settings: z.object({ step: z.number().int().min(1).default(1) }),
      }),
      {
        kv: { boots: z.number() },
        async setup(ctx) {
          calls.push('counter');
          await ctx.kv.set('boots', 1);
          return { rpc: { double: ({ n }) => n * 2 } };
        },
      },
    ),
    listener: definePlugin(listenerContract, {
      dependencies: [counterContract],
      setup() {
        calls.push('listener');
      },
    }),
    broken: definePlugin(brokenContract, {
      setup() {
        throw new Error('boom');
      },
    }),
  };
  const sqlite = options.sqlite ?? openDatabase(':memory:');
  const storage = createStorage(sqlite, randomBytes(32));
  const kernel = new Kernel({ logger: createMemoryLogger(), storage });
  const manager = new PluginManager({
    kernel,
    sqlite,
    roots: [root],
    logger: createMemoryLogger(),
    ...(options.maxBundleBytes === undefined ? {} : { maxBundleBytes: options.maxBundleBytes }),
    load: (plugin) => {
      loadScopes.push(currentPlugin());
      const definition = definitions[plugin.id];
      if (!definition) return Promise.reject(new Error(`no definition for ${plugin.id}`));
      return Promise.resolve(definition);
    },
  });
  return { manager, kernel, storage, sqlite, calls, definitions, root, loadScopes };
}

describe('PluginManager', () => {
  it('starts enabled plugins in dependency order and leaves the rest disabled', async () => {
    const { manager, sqlite, calls } = await setup();
    const store = new PluginStateStore(sqlite);
    store.setEnabled('listener', true);
    store.setEnabled('counter', true);
    await manager.start();
    expect(calls).toEqual(['counter', 'listener']);
    expect(manager.list().map((p) => [p.id, p.state, p.enabled])).toEqual([
      ['broken', 'disabled', false],
      ['counter', 'running', true],
      ['listener', 'running', true],
    ]);
  });

  it('requires confirmation to enable missing dependencies', async () => {
    const { manager } = await setup();
    await manager.start();
    const error: unknown = await manager.enable('listener').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DependencyActionRequired);
    expect((error as DependencyActionRequired).plugins).toEqual(['counter']);
    await manager.enable('listener', { withDependencies: true });
    expect(manager.get('counter')).toMatchObject({ state: 'running', enabled: true });
    expect(manager.get('listener')).toMatchObject({ state: 'running', enabled: true });
  });

  it('requires confirmation to disable running dependents', async () => {
    const { manager } = await setup();
    await manager.start();
    await manager.enable('listener', { withDependencies: true });
    await expect(manager.disable('counter')).rejects.toBeInstanceOf(DependencyActionRequired);
    await manager.disable('counter', { withDependents: true });
    expect(manager.get('counter')).toMatchObject({ state: 'disabled', enabled: false });
    expect(manager.get('listener')).toMatchObject({ state: 'disabled', enabled: false });
  });

  it('marks plugins failed when setup throws and reports why', async () => {
    const { manager } = await setup();
    await manager.start();
    await expect(manager.enable('broken')).rejects.toThrow('boom');
    expect(manager.get('broken')).toMatchObject({ state: 'failed', enabled: true, error: 'boom' });
    await manager.disable('broken');
    expect(manager.get('broken')).toMatchObject({ state: 'disabled', enabled: false });
  });

  it('reports graph problems as failed plugins', async () => {
    const { manager } = await setup({ listenerRange: '^2.0.0' });
    await manager.start();
    expect(manager.get('listener')).toMatchObject({
      state: 'failed',
      error: 'requires "counter@^2.0.0", found 1.0.0',
    });
    await expect(manager.enable('listener', { withDependencies: true })).rejects.toThrow(
      /cannot be loaded: requires "counter@\^2\.0\.0"/,
    );
  });

  it('reloads a plugin and restarts its dependents', async () => {
    const { manager, calls } = await setup();
    await manager.start();
    await manager.enable('listener', { withDependencies: true });
    await manager.reload('counter');
    expect(calls).toEqual(['counter', 'listener', 'counter', 'listener']);
    expect(manager.get('listener').state).toBe('running');
  });

  it('serializes concurrent lifecycle actions', async () => {
    const { manager } = await setup();
    await manager.start();
    const enabling = manager.enable('counter');
    const disabling = manager.disable('counter');
    await Promise.all([enabling, disabling]);
    expect(manager.get('counter')).toMatchObject({ state: 'disabled', enabled: false });
  });

  it('remembers enabled plugins across restarts', async () => {
    const sqlite = openDatabase(':memory:');
    const first = await setup({ sqlite });
    await first.manager.start();
    await first.manager.enable('counter');
    const second = await setup({ sqlite });
    await second.manager.start();
    expect(second.manager.get('counter').state).toBe('running');
  });

  it('deletes data only of stopped plugins', async () => {
    const { manager, storage } = await setup();
    await manager.start();
    await manager.enable('counter');
    expect(storage.kv.get('counter', 'boots')).toBe(1);
    await expect(manager.deleteData('counter')).rejects.toThrow(/Disable plugin "counter"/);
    await manager.disable('counter');
    await manager.deleteData('counter');
    expect(storage.kv.get('counter', 'boots')).toBeUndefined();
  });

  it('notifies listeners about state changes', async () => {
    const { manager } = await setup();
    await manager.start();
    const states: string[] = [];
    manager.onChange((info) => {
      if (info.id === 'counter') states.push(info.state);
    });
    await manager.enable('counter');
    await manager.disable('counter');
    expect(states).toEqual(['starting', 'running', 'stopping', 'disabled']);
  });

  it('reports a failed reload like a failed enable', async () => {
    const { manager, definitions } = await setup();
    await manager.start();
    await manager.enable('counter');
    definitions.counter = definePlugin(counterContract, {
      setup() {
        throw new Error('reload boom');
        return { rpc: { double: ({ n }) => n * 2 } };
      },
    });
    await expect(manager.reload('counter')).rejects.toThrow('reload boom');
    expect(manager.get('counter')).toMatchObject({ state: 'failed', error: 'reload boom' });
  });

  it('keeps runtime failures across rescans', async () => {
    const { manager } = await setup();
    await manager.start();
    await expect(manager.enable('broken')).rejects.toThrow('boom');
    await manager.rescan();
    expect(manager.get('broken')).toMatchObject({ state: 'failed', enabled: true, error: 'boom' });
  });

  it('notifies listeners about problems found by a rescan', async () => {
    const { manager, root } = await setup();
    await manager.start();
    const seen: [string, string][] = [];
    manager.onChange((info) => {
      seen.push([info.id, info.state]);
    });
    await writeManifest(root, 'listener', { counter: '^2.0.0' });
    await manager.rescan();
    expect(seen).toEqual([['listener', 'failed']]);
  });

  it('refuses to delete data of enabled plugins', async () => {
    const { manager } = await setup();
    await manager.start();
    await expect(manager.enable('broken')).rejects.toThrow('boom');
    await expect(manager.deleteData('broken')).rejects.toThrow(
      'Disable plugin "broken" before deleting its data',
    );
  });

  it('runs plugin module code attributed to the plugin', async () => {
    const { manager, loadScopes } = await setup();
    await manager.start();
    await manager.enable('counter');
    expect(loadScopes).toEqual(['counter']);
  });

  it('announces plugins whose folder disappeared', async () => {
    const { manager, root } = await setup();
    await manager.start();
    const removed: string[] = [];
    manager.onRemoved((id) => {
      removed.push(id);
    });
    await rm(join(root, 'broken'), { recursive: true });
    await manager.rescan();
    expect(removed).toEqual(['broken']);
    expect(manager.list().map((p) => p.id)).toEqual(['counter', 'listener']);
  });

  it('stops all running plugins, dependents first, and keeps them enabled', async () => {
    const { manager, kernel, sqlite } = await setup();
    await manager.start();
    await manager.enable('listener', { withDependencies: true });
    const stopping: string[] = [];
    manager.onChange((info) => {
      if (info.state === 'stopping') stopping.push(info.id);
    });
    await manager.stopAll();
    expect(stopping).toEqual(['listener', 'counter']);
    expect(kernel.isRunning('counter')).toBe(false);
    const store = new PluginStateStore(sqlite);
    expect(store.isEnabled('counter') && store.isEnabled('listener')).toBe(true);
  });

  it('stops reporting health changes after dispose', async () => {
    const { manager, kernel } = await setup();
    await manager.start();
    await manager.enable('counter');
    const changes: string[] = [];
    manager.onChange((info) => {
      changes.push(info.id);
    });
    manager.dispose();
    runInPlugin('counter', () => kernel.reportUncaught(new Error('late')));
    expect(changes).toEqual([]);
  });

  it('returns stored settings and their schema, also for stopped plugins', async () => {
    const { manager } = await setup();
    await manager.start();
    const initial = await manager.settings('counter');
    expect(initial.values).toEqual({ step: 1 });
    expect(initial.schema).toBeDefined();
    await manager.updateSettings('counter', { step: 3 });
    await expect(manager.settings('counter')).resolves.toMatchObject({ values: { step: 3 } });
  });
});
describe('PluginManager UI facts', () => {
  it("loads a stopped plugin's definition once and then reports hasSettings", async () => {
    const { manager, loadScopes } = await setup();
    await manager.start();
    expect(manager.get('counter')).not.toHaveProperty('hasSettings');
    await manager.settings('counter');
    await manager.settings('counter');
    await manager.updateSettings('counter', { step: 2 });
    expect(loadScopes).toEqual(['counter']);
    expect(manager.get('counter')).toMatchObject({ hasSettings: true, hasPanel: false });
    expect(manager.get('listener').hasSettings).toBeUndefined();
    // Starting always imports fresh code.
    await manager.enable('counter');
    expect(loadScopes).toEqual(['counter', 'counter']);
    await manager.rescan();
    await manager.disable('counter', { withDependents: true });
    await manager.settings('counter');
    expect(loadScopes).toEqual(['counter', 'counter']);
  });

  it('forgets cached definitions of stopped plugins on rescan', async () => {
    const { manager, loadScopes } = await setup();
    await manager.start();
    await manager.settings('counter');
    await manager.rescan();
    await manager.settings('counter');
    expect(loadScopes).toEqual(['counter', 'counter']);
  });

  it('reports the panel bundle of running plugins only', async () => {
    const { manager, root } = await setup();
    await writeFile(
      join(root, 'counter', 'package.json'),
      JSON.stringify({
        name: 'counter',
        version: '1.0.0',
        petalbot: {
          id: 'counter',
          apiVersion: 1,
          entries: { server: 'server.js', panel: 'dist/panel/panel.js' },
        },
      }),
    );
    await mkdir(join(root, 'counter', 'dist', 'panel'), { recursive: true });
    await writeFile(join(root, 'counter', 'dist', 'panel', 'panel.js'), 'export default 1;');
    await writeFile(join(root, 'counter', 'dist', 'panel', 'panel.css'), '.a{}');
    await manager.start();
    expect(manager.get('counter')).toMatchObject({ hasPanel: true });
    expect(manager.get('counter').panel).toBeUndefined();
    await manager.enable('counter');
    const bundle = manager.panelSnapshot('counter');
    expect(bundle?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(manager.get('counter').panel).toEqual({
      entry: `/plugins/counter/${bundle?.hash ?? ''}/panel.js`,
      styles: [`/plugins/counter/${bundle?.hash ?? ''}/panel.css`],
    });
    await manager.disable('counter', { withDependents: true });
    expect(manager.panelSnapshot('counter')).toBeUndefined();
    expect(manager.get('counter').panel).toBeUndefined();
  });

  it('refuses to start a plugin whose bundles are too large, without running setup', async () => {
    const { manager, root, calls } = await setup({ maxBundleBytes: 100 });
    await writeFile(
      join(root, 'counter', 'package.json'),
      JSON.stringify({
        name: 'counter',
        version: '1.0.0',
        petalbot: {
          id: 'counter',
          apiVersion: 1,
          entries: { server: 'server.js', panel: 'dist/panel/panel.js' },
        },
      }),
    );
    await mkdir(join(root, 'counter', 'dist', 'panel'), { recursive: true });
    await writeFile(join(root, 'counter', 'dist', 'panel', 'panel.js'), 'x'.repeat(200));
    await manager.start();
    await expect(manager.enable('counter')).rejects.toThrow('larger than 100 bytes');
    expect(manager.get('counter')).toMatchObject({ state: 'failed' });
    expect(calls).not.toContain('counter');
  });

  it('starts a plugin whose panel is not built, without a bundle', async () => {
    const { manager, root } = await setup();
    await writeFile(
      join(root, 'counter', 'package.json'),
      JSON.stringify({
        name: 'counter',
        version: '1.0.0',
        petalbot: {
          id: 'counter',
          apiVersion: 1,
          entries: { server: 'server.js', panel: 'dist/panel/panel.js' },
        },
      }),
    );
    await manager.start();
    await manager.enable('counter');
    expect(manager.get('counter')).toMatchObject({ state: 'running', hasPanel: true });
    expect(manager.get('counter').panel).toBeUndefined();
  });
});
