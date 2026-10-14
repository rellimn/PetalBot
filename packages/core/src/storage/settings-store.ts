import type { Sqlite } from './database.ts';

/** Raw stored settings per plugin; validation happens in the Kernel. */
export class SettingsStore {
  readonly #select;
  readonly #upsert;
  readonly #remove;

  constructor(sqlite: Sqlite) {
    this.#select = sqlite.prepare<[string], { value: string }>(
      'SELECT value FROM petalbot_settings WHERE plugin_id = ?',
    );
    this.#upsert = sqlite.prepare<[string, string]>(
      'INSERT INTO petalbot_settings (plugin_id, value) VALUES (?, ?) ' +
        'ON CONFLICT (plugin_id) DO UPDATE SET value = excluded.value',
    );
    this.#remove = sqlite.prepare<[string]>('DELETE FROM petalbot_settings WHERE plugin_id = ?');
  }

  read(pluginId: string): Record<string, unknown> {
    const row = this.#select.get(pluginId);
    if (!row) return {};
    const value = JSON.parse(row.value) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  write(pluginId: string, value: unknown): void {
    this.#upsert.run(pluginId, JSON.stringify(value));
  }

  delete(pluginId: string): void {
    this.#remove.run(pluginId);
  }
}
