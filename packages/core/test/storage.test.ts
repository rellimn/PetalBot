import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Sqlite } from '../src/storage/database.ts';
import { KvStore } from '../src/storage/kv-store.ts';
import { SettingsStore } from '../src/storage/settings-store.ts';

const tables = (sqlite: Sqlite): string[] =>
  (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe('openDatabase', () => {
  it('creates the core tables', () => {
    expect(tables(openDatabase(':memory:'))).toEqual([
      'petalbot_kv',
      'petalbot_plugin_state',
      'petalbot_secrets',
      'petalbot_settings',
    ]);
  });

  it('reopens an existing file without losing data', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'petalbot-db-')), 'test.db');
    const first = openDatabase(path);
    new SettingsStore(first).write('quotes', { prefix: '?' });
    first.close();
    const second = openDatabase(path);
    expect(new SettingsStore(second).read('quotes')).toEqual({ prefix: '?' });
    second.close();
  });
});

describe('SettingsStore', () => {
  it('reads {} when nothing is stored, then round-trips per plugin', () => {
    const store = new SettingsStore(openDatabase(':memory:'));
    expect(store.read('quotes')).toEqual({});
    store.write('quotes', { prefix: '?' });
    store.write('quotes', { prefix: '#' });
    store.write('alerts', { volume: 3 });
    expect(store.read('quotes')).toEqual({ prefix: '#' });
    store.delete('quotes');
    expect(store.read('quotes')).toEqual({});
    expect(store.read('alerts')).toEqual({ volume: 3 });
  });
});

describe('KvStore', () => {
  it('round-trips JSON values per plugin and key', () => {
    const store = new KvStore(openDatabase(':memory:'));
    expect(store.get('quotes', 'count')).toBeUndefined();
    store.set('quotes', 'count', 1);
    store.set('quotes', 'count', 2);
    store.set('quotes', 'last', { user: 'a' });
    store.set('alerts', 'count', 9);
    expect(store.get('quotes', 'count')).toBe(2);
    expect(store.get('quotes', 'last')).toEqual({ user: 'a' });
    store.delete('quotes', 'count');
    expect(store.get('quotes', 'count')).toBeUndefined();
    store.deleteAll('quotes');
    expect(store.get('quotes', 'last')).toBeUndefined();
    expect(store.get('alerts', 'count')).toBe(9);
  });
});
