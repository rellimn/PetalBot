import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  PluginUnavailableError,
  ValidationError,
  defineContract,
  definePlugin,
} from '@petalbot/sdk';
import { Kernel } from '../src/kernel.ts';
import { currentPlugin } from '../src/plugin-scope.ts';
import { openDatabase } from '../src/storage/database.ts';
import { createStorage, type KernelStorage } from '../src/storage/storage.ts';
import { notes } from './fixtures/notes-db/schema.ts';
import { notesDir } from './fixtures/paths.ts';
import { counterContract, createMemoryLogger, delay, listenerContract } from './helpers.ts';

const settingsSchema = z.object({
  prefix: z.string().default('!'),
  cooldownMs: z.number().int().min(0).default(3000),
});
const settingsContract = defineContract({ ...counterContract, settings: settingsSchema });
const double = ({ n }: { n: number }) => n * 2;
const notesContract = defineContract({ id: 'notes', version: '1.0.0' });

function setup(options: { setupTimeoutMs?: number } = {}) {
  const storage: KernelStorage = createStorage(openDatabase(':memory:'), randomBytes(32));
  const kernel = new Kernel({ logger: createMemoryLogger(), storage, ...options });
  return { storage, kernel };
}

describe('Kernel settings', () => {
  it('applies defaults and loads stored settings', async () => {
    const { storage, kernel } = setup();
    storage.settings.write('counter', { prefix: '?' });
    const seen: unknown[] = [];
    await kernel.start(
      definePlugin(settingsContract, {
        setup(ctx) {
          seen.push(ctx.settings.get());
          return { rpc: { double } };
        },
      }),
    );
    expect(seen).toEqual([{ prefix: '?', cooldownMs: 3000 }]);
  });

  it('refuses to start with invalid stored settings', async () => {
    const { storage, kernel } = setup();
    storage.settings.write('counter', { cooldownMs: -1 });
    const plugin = definePlugin(settingsContract, {
      setup() {
        return { rpc: { double } };
      },
    });
    await expect(kernel.start(plugin)).rejects.toThrow(
      /Invalid stored settings of plugin "counter": cooldownMs/,
    );
    expect(kernel.isRunning('counter')).toBe(false);
  });

  it('validates, persists and announces settings updates', async () => {
    const { storage, kernel } = setup();
    const changes: unknown[][] = [];
    const scopes: (string | undefined)[] = [];
    const plugin = definePlugin(settingsContract, {
      setup(ctx) {
        ctx.settings.onChange((next, previous) => {
          changes.push([next, previous]);
          scopes.push(currentPlugin());
        });
        return { rpc: { double } };
      },
    });
    await kernel.start(plugin);
    await expect(kernel.updateSettings(plugin, { cooldownMs: -5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(storage.settings.read('counter')).toEqual({});
    await expect(kernel.updateSettings(plugin, { prefix: '#' })).resolves.toEqual({
      prefix: '#',
      cooldownMs: 3000,
    });
    expect(storage.settings.read('counter')).toEqual({ prefix: '#' });
    expect(changes).toEqual([
      [
        { prefix: '#', cooldownMs: 3000 },
        { prefix: '!', cooldownMs: 3000 },
      ],
    ]);
    expect(scopes).toEqual(['counter']);
  });

  it('stores settings of stopped plugins without notifying anyone', async () => {
    const { storage, kernel } = setup();
    const plugin = definePlugin(settingsContract, {
      setup() {
        return { rpc: { double } };
      },
    });
    await kernel.updateSettings(plugin, { prefix: '$' });
    expect(storage.settings.read('counter')).toEqual({ prefix: '$' });
  });
});

describe('Kernel kv and secrets', () => {
  const kvContract = defineContract({ id: 'kvtest', version: '1.0.0' });

  it('updates kv values atomically, even with many concurrent callers', async () => {
    const { kernel, storage } = setup();
    const done: Promise<unknown>[] = [];
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int(), names: z.array(z.string()) },
        setup(ctx) {
          for (let i = 0; i < 100; i += 1) {
            done.push(ctx.kv.update('total', (current) => (current ?? 0) + 1));
          }
          done.push(ctx.kv.update('names', (current = []) => [...current, 'a']));
        },
      }),
    );
    await Promise.all(done);
    expect(storage.kv.get('kvtest', 'total')).toBe(100);
    expect(storage.kv.get('kvtest', 'names')).toEqual(['a']);
  });

  it('resolves kv.update to the stored value and deletes on undefined', async () => {
    const { kernel, storage } = setup();
    const results: unknown[] = [];
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int() },
        async setup(ctx) {
          results.push(await ctx.kv.update('total', () => 5));
          results.push(await ctx.kv.update('total', () => undefined));
        },
      }),
    );
    expect(results).toEqual([5, undefined]);
    expect(storage.kv.get('kvtest', 'total')).toBeUndefined();
  });

  it('writes nothing when the updater throws or returns an invalid value', async () => {
    const { kernel, storage } = setup();
    storage.kv.set('kvtest', 'total', 1);
    const errors: unknown[] = [];
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int() },
        async setup(ctx) {
          await ctx.kv
            .update('total', () => {
              throw new Error('boom');
            })
            .catch((error: unknown) => errors.push(error));
          await ctx.kv.update('total', () => 1.5).catch((error: unknown) => errors.push(error));
        },
      }),
    );
    expect(errors[0]).toEqual(new Error('boom'));
    expect(errors[1]).toBeInstanceOf(ValidationError);
    expect(storage.kv.get('kvtest', 'total')).toBe(1);
  });

  it('rejects an async updater, writes nothing and leaves no unhandled rejection', async () => {
    const { kernel, storage } = setup();
    let error: unknown;
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int() },
        async setup(ctx) {
          // Untyped on purpose: plain JS can pass an async updater, which the types forbid.
          const kv = ctx.kv as unknown as {
            update(key: string, fn: () => unknown): Promise<unknown>;
          };
          error = await kv
            .update('total', () => Promise.reject(new Error('late')))
            .catch((caught: unknown) => caught);
        },
      }),
    );
    await delay(5);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain('must be synchronous');
    expect(storage.kv.get('kvtest', 'total')).toBeUndefined();
    expect(kernel.isDegraded('kvtest')).toBe(false);
  });

  it('rejects kv.update when the stored value no longer matches the schema', async () => {
    const { kernel, storage } = setup();
    storage.kv.set('kvtest', 'total', 'not a number');
    let error: unknown;
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int() },
        async setup(ctx) {
          error = await ctx.kv.update('total', (n) => (n ?? 0) + 1).catch((e: unknown) => e);
        },
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(String(error)).toContain('stored kv "total" of plugin "kvtest"');
    expect(storage.kv.get('kvtest', 'total')).toBe('not a number');
  });

  it('serializes async sections with ctx.lock', async () => {
    const { kernel, storage } = setup();
    const done: Promise<unknown>[] = [];
    await kernel.start(
      definePlugin(kvContract, {
        kv: { total: z.number().int() },
        setup(ctx) {
          const addOne = () =>
            ctx.lock('total', async () => {
              const current = (await ctx.kv.get('total')) ?? 0;
              await delay(2);
              await ctx.kv.set('total', current + 1);
            });
          done.push(addOne(), addOne(), addOne());
        },
      }),
    );
    await Promise.all(done);
    expect(storage.kv.get('kvtest', 'total')).toBe(3);
  });

  it('rejects waiting lock callers before slow disposers finish', async () => {
    const { kernel } = setup();
    const waiting: Promise<unknown>[] = [];
    let releaseLock = (): void => undefined;
    let releaseDispose = (): void => undefined;
    const started: string[] = [];
    await kernel.start(
      definePlugin(kvContract, {
        setup(ctx) {
          void ctx.lock(
            'k',
            () =>
              new Promise<void>((resolve) => {
                releaseLock = resolve;
              }),
          );
          for (const name of ['b', 'c']) {
            waiting.push(
              ctx.lock('k', () => {
                started.push(name);
              }),
            );
          }
          ctx.onDispose(
            () =>
              new Promise<void>((resolve) => {
                releaseDispose = resolve;
              }),
          );
        },
      }),
    );
    const stopping = kernel.stop('kvtest');
    const outcomes = await Promise.allSettled(waiting);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    releaseLock();
    await delay(5);
    expect(started).toEqual([]);
    releaseDispose();
    await stopping;
  });

  it('rejects waiting callers as soon as the plugin stops', async () => {
    const { kernel } = setup();
    let waiting: Promise<unknown> = Promise.resolve();
    let release = (): void => undefined;
    await kernel.start(
      definePlugin(kvContract, {
        setup(ctx) {
          void ctx.lock(
            'k',
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          );
          waiting = ctx.lock('k', () => 'never');
        },
      }),
    );
    const stopping = kernel.stop('kvtest');
    await expect(waiting).rejects.toBeInstanceOf(PluginUnavailableError);
    release();
    await stopping;
  });

  it('validates kv keys and values and keeps them across restarts', async () => {
    const { kernel } = setup();
    const kv = { total: z.number().int() };
    await kernel.start(
      definePlugin(counterContract, {
        kv,
        async setup(ctx) {
          expect(await ctx.kv.get('total')).toBeUndefined();
          await ctx.kv.set('total', 5);
          await expect(ctx.kv.set('total', 1.5)).rejects.toBeInstanceOf(ValidationError);
          const untyped = ctx.kv as unknown as { get(key: string): Promise<unknown> };
          await expect(untyped.get('nope')).rejects.toBeInstanceOf(AccessError);
          return { rpc: { double } };
        },
      }),
    );
    await kernel.stop('counter');
    const seen: unknown[] = [];
    await kernel.start(
      definePlugin(counterContract, {
        kv,
        async setup(ctx) {
          seen.push(await ctx.kv.get('total'));
          return { rpc: { double } };
        },
      }),
    );
    expect(seen).toEqual([5]);
  });

  it('stores secrets encrypted', async () => {
    const { storage, kernel } = setup();
    await kernel.start(
      definePlugin(defineContract({ ...counterContract, secrets: { token: {} } }), {
        async setup(ctx) {
          await ctx.secrets.set('token', 'abc123');
          expect(await ctx.secrets.get('token')).toBe('abc123');
          return { rpc: { double } };
        },
      }),
    );
    const raw = storage.sqlite.prepare('SELECT * FROM petalbot_secrets').all();
    expect(JSON.stringify(raw)).not.toContain('abc123');
  });
});

describe('Kernel db, schedule and isRunning', () => {
  it('gives plugins with a db declaration their migrated database', async () => {
    const { kernel } = setup();
    const rows: unknown[] = [];
    await kernel.start(
      definePlugin(notesContract, {
        db: { schema: { notes }, migrations: 'migrations' },
        setup(ctx) {
          ctx.db.insert(notes).values({ text: 'hi' }).run();
          rows.push(...ctx.db.select().from(notes).all());
        },
      }),
      { dir: notesDir },
    );
    expect(rows).toEqual([{ id: 1, text: 'hi' }]);
  });

  it('reads migrations relative to the plugin folder and needs that folder', async () => {
    const { kernel } = setup();
    const plugin = definePlugin(notesContract, {
      db: { schema: { notes }, migrations: 'migrations' },
      setup(ctx) {
        ctx.db.insert(notes).values({ text: 'hi' }).run();
      },
    });
    await expect(kernel.start(plugin)).rejects.toThrow(
      'Plugin "notes" declares db, so the kernel needs its folder: start(definition, { dir })',
    );
    await kernel.start(plugin, { dir: notesDir });
    expect(kernel.isRunning('notes')).toBe(true);
  });

  it('refuses a migrations folder outside the plugin folder', async () => {
    const { kernel } = setup();
    const plugin = definePlugin(notesContract, {
      db: { schema: { notes }, migrations: '../foreign-db/migrations' },
      setup() {
        // nothing to set up
      },
    });
    await expect(kernel.start(plugin, { dir: notesDir })).rejects.toThrow(
      'The migrations folder of plugin "notes" must be inside the plugin folder',
    );
  });

  it('rejects ctx.db for plugins without a db declaration', async () => {
    const { kernel } = setup();
    await kernel.start(
      definePlugin(notesContract, {
        setup(ctx) {
          expect(() => (ctx as unknown as { db: unknown }).db).toThrow(AccessError);
        },
      }),
    );
  });

  it('runs scheduled jobs until the plugin stops', async () => {
    const { kernel } = setup();
    const fired: string[] = [];
    await kernel.start(
      definePlugin(notesContract, {
        setup(ctx) {
          ctx.schedule.after(5, () => {
            fired.push('early');
          });
          ctx.schedule.after(60, () => {
            fired.push('late');
          });
        },
      }),
    );
    await delay(30);
    await kernel.stop('notes');
    await delay(60);
    expect(fired).toEqual(['early']);
  });

  it('reports whether dependencies are running', async () => {
    const { kernel } = setup();
    const probe: { isRunning?: () => boolean; untyped?: (id: string) => boolean } = {};
    await kernel.start(
      definePlugin(listenerContract, {
        optionalDependencies: [counterContract],
        setup(ctx) {
          probe.isRunning = () => ctx.isRunning('counter');
          probe.untyped = (id) =>
            (ctx as unknown as { isRunning(id: string): boolean }).isRunning(id);
        },
      }),
    );
    expect(probe.isRunning?.()).toBe(false);
    await kernel.start(
      definePlugin(counterContract, {
        setup() {
          return { rpc: { double } };
        },
      }),
    );
    expect(probe.isRunning?.()).toBe(true);
    expect(() => probe.untyped?.('other')).toThrow(AccessError);
  });
});

describe('Kernel lifecycle safety', () => {
  it('fails a setup that does not finish in time', async () => {
    const { kernel } = setup({ setupTimeoutMs: 20 });
    await expect(
      kernel.start(
        definePlugin(notesContract, {
          setup: () => new Promise<void>(() => undefined),
        }),
      ),
    ).rejects.toThrow(/Setup of plugin "notes" timed out after 20 ms/);
    expect(kernel.isRunning('notes')).toBe(false);
  });

  it("deletes a stopped plugin's data and refuses while it runs", async () => {
    const { storage, kernel } = setup();
    const notesWithSettings = defineContract({
      ...notesContract,
      settings: z.object({ a: z.number().default(1) }),
      secrets: { s: {} },
    });
    const plugin = definePlugin(notesWithSettings, {
      db: { schema: { notes }, migrations: 'migrations' },
      kv: { k: z.number() },
      async setup(ctx) {
        await ctx.kv.set('k', 1);
        await ctx.secrets.set('s', 'v');
      },
    });
    await kernel.start(plugin, { dir: notesDir });
    await kernel.updateSettings(plugin, { a: 2 });
    expect(() => kernel.deleteData('notes')).toThrow(/Stop plugin "notes"/);
    await kernel.stop('notes');
    expect(kernel.deleteData('notes')).toEqual(['notes_items', 'petalbot_migrations_notes']);
    expect(storage.kv.get('notes', 'k')).toBeUndefined();
    expect(storage.secrets.get('notes', 's')).toBeUndefined();
    expect(storage.settings.read('notes')).toEqual({});
  });

  it('runs disposers attributed to the plugin', async () => {
    const { kernel } = setup();
    const scopes: (string | undefined)[] = [];
    await kernel.start(
      definePlugin(notesContract, {
        setup(ctx) {
          ctx.onDispose(() => {
            scopes.push(currentPlugin());
          });
        },
      }),
    );
    await kernel.stop('notes');
    expect(scopes).toEqual(['notes']);
  });

  it('stops a plugin even if a disposer hangs', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger(), disposeTimeoutMs: 20 });
    await kernel.start(
      definePlugin(notesContract, {
        setup(ctx) {
          ctx.onDispose(() => new Promise<void>(() => undefined));
        },
      }),
    );
    await kernel.stop('notes');
    expect(kernel.isRunning('notes')).toBe(false);
  });

  it('does not wait forever for a settings listener', async () => {
    const kernel = new Kernel({ logger: createMemoryLogger(), listenerTimeoutMs: 20 });
    const plugin = definePlugin(settingsContract, {
      setup(ctx) {
        ctx.settings.onChange(() => new Promise<void>(() => undefined));
        return { rpc: { double } };
      },
    });
    await kernel.start(plugin);
    await expect(kernel.updateSettings(plugin, { prefix: '#' })).resolves.toEqual({
      prefix: '#',
      cooldownMs: 3000,
    });
  });
});

describe('Kernel storage round-trips', () => {
  const tagsSchema = z.object({
    tags: z
      .string()
      .default('a,b')
      .transform((value) => value.split(',')),
  });

  it('keeps transformed settings startable after an update', async () => {
    const { storage, kernel } = setup();
    const tagsContract = defineContract({ ...counterContract, settings: tagsSchema });
    const plugin = definePlugin(tagsContract, {
      setup() {
        return { rpc: { double } };
      },
    });
    await expect(kernel.updateSettings(plugin, { tags: 'x,y' })).resolves.toEqual({
      tags: ['x', 'y'],
    });
    expect(storage.settings.read('counter')).toEqual({ tags: 'x,y' });
    const seen: unknown[] = [];
    await kernel.start(
      definePlugin(tagsContract, {
        setup(ctx) {
          seen.push(ctx.settings.get());
          return { rpc: { double } };
        },
      }),
    );
    expect(seen).toEqual([{ tags: ['x', 'y'] }]);
  });

  it('round-trips kv values through their schema input', async () => {
    const { kernel } = setup();
    await kernel.start(
      definePlugin(counterContract, {
        kv: { length: z.string().transform((value) => value.length), note: z.string().optional() },
        async setup(ctx) {
          await ctx.kv.set('length', 'abc');
          expect(await ctx.kv.get('length')).toBe(3);
          await ctx.kv.set('note', 'x');
          await ctx.kv.set('note', undefined);
          expect(await ctx.kv.get('note')).toBeUndefined();
          return { rpc: { double } };
        },
      }),
    );
  });

  it('rejects kv values that do not survive JSON', async () => {
    const { kernel } = setup();
    await kernel.start(
      definePlugin(counterContract, {
        kv: { when: z.date() },
        async setup(ctx) {
          await expect(ctx.kv.set('when', new Date())).rejects.toThrow(
            'kv "when" of plugin "counter" must be JSON-serializable',
          );
          return { rpc: { double } };
        },
      }),
    );
  });
});
