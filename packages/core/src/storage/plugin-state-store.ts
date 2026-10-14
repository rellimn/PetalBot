import type { Sqlite } from './database.ts';

/** Persisted enabled/disabled choice per plugin. Unknown plugins are disabled. */
export class PluginStateStore {
  readonly #select;
  readonly #upsert;

  constructor(sqlite: Sqlite) {
    this.#select = sqlite.prepare<[string], { enabled: number }>(
      'SELECT enabled FROM petalbot_plugin_state WHERE plugin_id = ?',
    );
    this.#upsert = sqlite.prepare<[string, number]>(
      'INSERT INTO petalbot_plugin_state (plugin_id, enabled) VALUES (?, ?) ' +
        'ON CONFLICT (plugin_id) DO UPDATE SET enabled = excluded.enabled',
    );
  }

  isEnabled(pluginId: string): boolean {
    return this.#select.get(pluginId)?.enabled === 1;
  }

  /** Whether a choice was ever stored (the plugin was enabled or disabled at least once). */
  has(pluginId: string): boolean {
    return this.#select.get(pluginId) !== undefined;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.#upsert.run(pluginId, enabled ? 1 : 0);
  }
}
