import type { Sqlite } from './database.ts';

/** Raw JSON key-value rows per plugin; schemas are applied by the Kernel. */
export class KvStore {
  readonly #select;
  readonly #upsert;
  readonly #remove;
  readonly #removeAll;
  readonly #update;

  constructor(sqlite: Sqlite) {
    this.#select = sqlite.prepare<[string, string], { value: string }>(
      'SELECT value FROM petalbot_kv WHERE plugin_id = ? AND key = ?',
    );
    this.#upsert = sqlite.prepare<[string, string, string]>(
      'INSERT INTO petalbot_kv (plugin_id, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value',
    );
    this.#remove = sqlite.prepare<[string, string]>(
      'DELETE FROM petalbot_kv WHERE plugin_id = ? AND key = ?',
    );
    this.#removeAll = sqlite.prepare<[string]>('DELETE FROM petalbot_kv WHERE plugin_id = ?');
    this.#update = sqlite.transaction(
      (pluginId: string, key: string, fn: (current: unknown) => unknown): unknown => {
        const next = fn(this.get(pluginId, key));
        if (next === undefined) this.delete(pluginId, key);
        else this.set(pluginId, key, next);
        return next;
      },
    );
  }

  get(pluginId: string, key: string): unknown {
    const row = this.#select.get(pluginId, key);
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  set(pluginId: string, key: string, value: unknown): void {
    this.#upsert.run(pluginId, key, JSON.stringify(value));
  }

  delete(pluginId: string, key: string): void {
    this.#remove.run(pluginId, key);
  }

  /** Runs `fn` on the current value inside one transaction; `undefined` from `fn` deletes the key. */
  update(pluginId: string, key: string, fn: (current: unknown) => unknown): unknown {
    return this.#update(pluginId, key, fn);
  }

  deleteAll(pluginId: string): void {
    this.#removeAll.run(pluginId);
  }
}
