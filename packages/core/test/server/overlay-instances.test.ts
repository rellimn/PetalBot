import { describe, expect, it } from 'vitest';
import {
  OverlayInstanceStore,
  type OverlayInstance,
  type RevokeReason,
} from '../../src/server/overlays/instance-store.ts';
import { hashToken } from '../../src/server/tokens.ts';
import { openDatabase } from '../../src/storage/database.ts';

function setup() {
  let now = 1000;
  const sqlite = openDatabase(':memory:');
  const store = new OverlayInstanceStore(sqlite, { now: () => now });
  const revoked: [string, RevokeReason][] = [];
  const updated: OverlayInstance[] = [];
  store.onRevoke((id, reason) => {
    revoked.push([id, reason]);
  });
  store.onUpdate((instance) => {
    updated.push(instance);
  });
  return {
    store,
    sqlite,
    revoked,
    updated,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('OverlayInstanceStore', () => {
  it('creates named instances that resolve by token, storing only the hash', () => {
    const { store, sqlite } = setup();
    const { instance, token } = store.create('alerts', 'box', 'Gaming scene', { durationMs: 3000 });
    expect(instance).toMatchObject({
      pluginId: 'alerts',
      overlay: 'box',
      name: 'Gaming scene',
      config: { durationMs: 3000 },
      createdAt: 1000,
      rotatedAt: 1000,
    });
    expect(store.findByToken(token)?.id).toBe(instance.id);
    expect(store.get(instance.id)).toEqual(instance);
    expect(store.list()).toEqual([instance]);
    const row = sqlite.prepare('SELECT token_hash FROM petalbot_overlay_instances').get();
    expect(row).toEqual({ token_hash: hashToken(token) });
    expect(store.findByToken('guess')).toBeUndefined();
  });

  it('rotates tokens: the old one stops working at once', () => {
    const { store, revoked, advance } = setup();
    const { instance, token } = store.create('alerts', 'box', 'Main', {});
    advance(500);
    const next = store.rotate(instance.id);
    expect(next).toBeDefined();
    expect(store.findByToken(token)).toBeUndefined();
    expect(store.findByToken(next ?? '')?.rotatedAt).toBe(1500);
    expect(revoked).toEqual([[instance.id, 'rotated']]);
    expect(store.rotate('missing')).toBeUndefined();
  });

  it('renames, replaces the config and announces each update', () => {
    const { store, updated } = setup();
    const { instance } = store.create('alerts', 'box', 'Main', { durationMs: 1 });
    expect(store.update(instance.id, { name: 'Side' })).toMatchObject({
      name: 'Side',
      config: { durationMs: 1 },
    });
    expect(store.update(instance.id, { config: { durationMs: 2 } })).toMatchObject({
      name: 'Side',
      config: { durationMs: 2 },
    });
    expect(store.get(instance.id)).toMatchObject({ name: 'Side', config: { durationMs: 2 } });
    expect(updated.map((entry) => entry.name)).toEqual(['Side', 'Side']);
    expect(store.update('missing', { name: 'x' })).toBeUndefined();
    expect(updated).toHaveLength(2);
  });

  it('revokes instances', () => {
    const { store, revoked } = setup();
    const { instance, token } = store.create('alerts', 'box', 'Main', {});
    expect(store.revoke(instance.id)).toBe(true);
    expect(store.revoke(instance.id)).toBe(false);
    expect(store.findByToken(token)).toBeUndefined();
    expect(revoked).toEqual([[instance.id, 'revoked']]);
  });

  it('deletes all instances of one plugin', () => {
    const { store, revoked } = setup();
    const a = store.create('alerts', 'box', 'A', {}).instance;
    const b = store.create('alerts', 'ticker', 'B', {}).instance;
    const other = store.create('quotes', 'box', 'C', {}).instance;
    expect(store.deleteByPlugin('alerts')).toBe(2);
    expect(store.list().map((i) => i.id)).toEqual([other.id]);
    expect(revoked.map(([id]) => id).sort()).toEqual([a.id, b.id].sort());
  });

  it('gives instances from before names existed the name "Overlay"', () => {
    const sqlite = openDatabase(':memory:');
    sqlite.exec(`CREATE TABLE petalbot_overlay_instances (
      id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, overlay TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, config TEXT NOT NULL,
      created_at INTEGER NOT NULL, rotated_at INTEGER NOT NULL)`);
    sqlite
      .prepare('INSERT INTO petalbot_overlay_instances VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old', 'alerts', 'box', 'hash', '{}', 1, 1);
    const store = new OverlayInstanceStore(sqlite);
    expect(store.get('old')).toMatchObject({ name: 'Overlay', config: {} });
  });
});
