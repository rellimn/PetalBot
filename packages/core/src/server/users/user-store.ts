import { ulid } from 'ulid';
import type { Sqlite } from '../../storage/database.ts';
import {
  MAX_PRESETS,
  preferencesSchema,
  presetInputSchema,
  type Preferences,
  type Preset,
  type PresetInput,
} from './schemas.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS petalbot_user_preferences (
  user_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS petalbot_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  columns TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS petalbot_presets_user ON petalbot_presets (user_id, created_at);
`;

interface PresetRow {
  readonly id: string;
  readonly name: string;
  readonly columns: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** The user already has MAX_PRESETS presets. */
export class PresetLimitError extends Error {
  constructor() {
    super(`A user can keep at most ${String(MAX_PRESETS)} presets`);
    this.name = 'PresetLimitError';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Appearance preferences and dashboard presets, keyed by the login subject. */
export class UserStore {
  readonly #now: () => number;
  readonly #getPreferences;
  readonly #putPreferences;
  readonly #listPresets;
  readonly #getPreset;
  readonly #countPresets;
  readonly #insertPreset;
  readonly #updatePreset;
  readonly #deletePreset;

  constructor(sqlite: Sqlite, options: { readonly now?: () => number } = {}) {
    sqlite.exec(SCHEMA);
    this.#now = options.now ?? Date.now;
    this.#getPreferences = sqlite.prepare<[string], { value: string }>(
      'SELECT value FROM petalbot_user_preferences WHERE user_id = ?',
    );
    this.#putPreferences = sqlite.prepare<[string, string]>(
      'INSERT INTO petalbot_user_preferences (user_id, value) VALUES (?, ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET value = excluded.value',
    );
    this.#listPresets = sqlite.prepare<[string], PresetRow>(
      'SELECT id, name, columns, created_at, updated_at FROM petalbot_presets ' +
        'WHERE user_id = ? ORDER BY created_at, id',
    );
    this.#getPreset = sqlite.prepare<[string, string], PresetRow>(
      'SELECT id, name, columns, created_at, updated_at FROM petalbot_presets ' +
        'WHERE user_id = ? AND id = ?',
    );
    this.#countPresets = sqlite.prepare<[string], { count: number }>(
      'SELECT COUNT(*) AS count FROM petalbot_presets WHERE user_id = ?',
    );
    this.#insertPreset = sqlite.prepare<[string, string, string, string, number, number]>(
      'INSERT INTO petalbot_presets (id, user_id, name, columns, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.#updatePreset = sqlite.prepare<[string, string, number, string, string]>(
      'UPDATE petalbot_presets SET name = ?, columns = ?, updated_at = ? WHERE user_id = ? AND id = ?',
    );
    this.#deletePreset = sqlite.prepare<[string, string]>(
      'DELETE FROM petalbot_presets WHERE user_id = ? AND id = ?',
    );
  }

  /** Stored preferences, or the defaults when none (or unreadable ones) are stored. */
  preferences(userId: string): Preferences {
    const row = this.#getPreferences.get(userId);
    const parsed = preferencesSchema.safeParse(row ? parseJson(row.value) : {});
    return parsed.success ? parsed.data : preferencesSchema.parse({});
  }

  setPreferences(userId: string, preferences: Preferences): Preferences {
    this.#putPreferences.run(userId, JSON.stringify(preferences));
    return preferences;
  }

  presets(userId: string): Preset[] {
    return this.#listPresets
      .all(userId)
      .map(toPreset)
      .filter((preset) => preset !== undefined);
  }

  preset(userId: string, id: string): Preset | undefined {
    const row = this.#getPreset.get(userId, id);
    return row ? toPreset(row) : undefined;
  }

  createPreset(userId: string, input: PresetInput): Preset {
    if ((this.#countPresets.get(userId)?.count ?? 0) >= MAX_PRESETS) throw new PresetLimitError();
    const now = this.#now();
    const preset: Preset = { id: ulid(), ...input, createdAt: now, updatedAt: now };
    this.#insertPreset.run(
      preset.id,
      userId,
      preset.name,
      JSON.stringify(preset.columns),
      now,
      now,
    );
    return preset;
  }

  updatePreset(userId: string, id: string, input: PresetInput): Preset | undefined {
    const now = this.#now();
    const changes = this.#updatePreset.run(
      input.name,
      JSON.stringify(input.columns),
      now,
      userId,
      id,
    ).changes;
    return changes === 0 ? undefined : this.preset(userId, id);
  }

  /** Deletes a preset; an active preset is replaced by `null` in the preferences. */
  deletePreset(userId: string, id: string): boolean {
    if (this.#deletePreset.run(userId, id).changes === 0) return false;
    const preferences = this.preferences(userId);
    if (preferences.activePreset === id) {
      this.setPreferences(userId, { ...preferences, activePreset: null });
    }
    return true;
  }
}

function toPreset(row: PresetRow): Preset | undefined {
  const parsed = presetInputSchema.safeParse({
    name: row.name,
    columns: parseJson(row.columns),
  });
  if (!parsed.success) return undefined;
  return { id: row.id, ...parsed.data, createdAt: row.created_at, updatedAt: row.updated_at };
}
