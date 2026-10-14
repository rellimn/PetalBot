import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.ts';
import { SecretStore, parseSecretKey } from '../src/storage/secret-store.ts';
import { createStorage } from '../src/storage/storage.ts';

describe('parseSecretKey', () => {
  it('accepts base64 of exactly 32 bytes', () => {
    const key = randomBytes(32);
    expect(parseSecretKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it('rejects a missing or wrongly sized key', () => {
    expect(() => parseSecretKey(undefined)).toThrow(/PETALBOT_SECRET_KEY is not set/);
    expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow(
      /must decode to 32 bytes, got 16/,
    );
  });
});

describe('SecretStore', () => {
  it('round-trips secrets per plugin and never stores plaintext', () => {
    const sqlite = openDatabase(':memory:');
    const store = new SecretStore(sqlite, randomBytes(32));
    expect(store.get('twitch', 'token')).toBeUndefined();
    store.set('twitch', 'token', 'super-secret-value');
    store.set('twitch', 'token', 'rotated-value');
    expect(store.get('twitch', 'token')).toBe('rotated-value');
    const raw = sqlite.prepare('SELECT * FROM petalbot_secrets').all();
    expect(JSON.stringify(raw)).not.toContain('rotated-value');
    store.delete('twitch', 'token');
    expect(store.get('twitch', 'token')).toBeUndefined();
  });

  it('fails clearly with the wrong key or a moved row', () => {
    const sqlite = openDatabase(':memory:');
    new SecretStore(sqlite, randomBytes(32)).set('twitch', 'token', 'value');
    expect(() => new SecretStore(sqlite, randomBytes(32)).get('twitch', 'token')).toThrow(
      /Secret "token" of plugin "twitch" cannot be decrypted/,
    );

    const key = randomBytes(32);
    const store = new SecretStore(sqlite, key);
    store.set('twitch', 'token', 'value');
    sqlite
      .prepare("UPDATE petalbot_secrets SET plugin_id = 'evil' WHERE plugin_id = 'twitch'")
      .run();
    expect(() => store.get('evil', 'token')).toThrow(/cannot be decrypted/);
  });

  it('deleteAll removes only that plugin', () => {
    const store = new SecretStore(openDatabase(':memory:'), randomBytes(32));
    store.set('twitch', 'a', '1');
    store.set('kick', 'a', '2');
    store.deleteAll('twitch');
    expect(store.get('twitch', 'a')).toBeUndefined();
    expect(store.get('kick', 'a')).toBe('2');
  });
});

describe('createStorage', () => {
  it('bundles all stores on one database', () => {
    const storage = createStorage(openDatabase(':memory:'), randomBytes(32));
    storage.settings.write('quotes', { a: 1 });
    storage.kv.set('quotes', 'k', 2);
    storage.secrets.set('quotes', 's', '3');
    expect(storage.settings.read('quotes')).toEqual({ a: 1 });
    expect(storage.kv.get('quotes', 'k')).toBe(2);
    expect(storage.secrets.get('quotes', 's')).toBe('3');
  });
});

describe('SecretStore.names', () => {
  it('lists the stored names of a plugin, sorted', () => {
    const store = new SecretStore(openDatabase(':memory:'), randomBytes(32));
    store.set('twitch', 'tokens/b', 'x');
    store.set('twitch', 'clientSecret', 'y');
    store.set('twitch', 'tokens/a', 'z');
    store.set('other', 'tokens/c', 'w');
    expect(store.names('twitch')).toEqual(['clientSecret', 'tokens/a', 'tokens/b']);
  });
});
