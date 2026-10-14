import type { Sqlite } from './database.ts';
import { KvStore } from './kv-store.ts';
import { SecretStore } from './secret-store.ts';
import { SettingsStore } from './settings-store.ts';

/** Everything the Kernel persists for plugins, on one SQLite connection. */
export interface KernelStorage {
  readonly sqlite: Sqlite;
  readonly settings: SettingsStore;
  readonly kv: KvStore;
  readonly secrets: SecretStore;
}

export function createStorage(sqlite: Sqlite, secretKey: Buffer): KernelStorage {
  return {
    sqlite,
    settings: new SettingsStore(sqlite),
    kv: new KvStore(sqlite),
    secrets: new SecretStore(sqlite, secretKey),
  };
}
