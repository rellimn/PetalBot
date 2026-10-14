import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Sqlite } from './database.ts';

/** Parses `PETALBOT_SECRET_KEY`: base64 of exactly 32 random bytes. */
export function parseSecretKey(encoded: string | undefined): Buffer {
  if (encoded === undefined || encoded === '') {
    throw new Error('PETALBOT_SECRET_KEY is not set (expected base64 of 32 random bytes)');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error(`PETALBOT_SECRET_KEY must decode to 32 bytes, got ${String(key.length)}`);
  }
  return key;
}

interface SecretRow {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * AES-256-GCM per secret with a random IV. Plugin id and name are authenticated data, so a row
 * moved to another plugin or name fails to decrypt.
 */
export class SecretStore {
  readonly #key: Buffer;
  readonly #select;
  readonly #upsert;
  readonly #remove;
  readonly #removeAll;

  constructor(sqlite: Sqlite, key: Buffer) {
    this.#key = key;
    this.#select = sqlite.prepare<[string, string], SecretRow>(
      'SELECT iv, tag, ciphertext FROM petalbot_secrets WHERE plugin_id = ? AND name = ?',
    );
    this.#upsert = sqlite.prepare<[string, string, Buffer, Buffer, Buffer]>(
      'INSERT INTO petalbot_secrets (plugin_id, name, iv, tag, ciphertext) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (plugin_id, name) DO UPDATE SET ' +
        'iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext',
    );
    this.#remove = sqlite.prepare<[string, string]>(
      'DELETE FROM petalbot_secrets WHERE plugin_id = ? AND name = ?',
    );
    this.#removeAll = sqlite.prepare<[string]>('DELETE FROM petalbot_secrets WHERE plugin_id = ?');
  }

  get(pluginId: string, name: string): string | undefined {
    const row = this.#select.get(pluginId, name);
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, row.iv);
      decipher.setAAD(aad(pluginId, name));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(
        `Secret "${name}" of plugin "${pluginId}" cannot be decrypted ` +
          '(wrong PETALBOT_SECRET_KEY or tampered data)',
      );
    }
  }

  set(pluginId: string, name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(aad(pluginId, name));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.#upsert.run(pluginId, name, iv, cipher.getAuthTag(), ciphertext);
  }

  delete(pluginId: string, name: string): void {
    this.#remove.run(pluginId, name);
  }

  deleteAll(pluginId: string): void {
    this.#removeAll.run(pluginId);
  }
}

function aad(pluginId: string, name: string): Buffer {
  return Buffer.from(`${pluginId}\0${name}`, 'utf8');
}
