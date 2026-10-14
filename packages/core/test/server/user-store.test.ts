import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.ts';
import { PresetLimitError, UserStore } from '../../src/server/users/user-store.ts';
import { MAX_PRESETS, type PresetInput } from '../../src/server/users/schemas.ts';

const layout: PresetInput = {
  name: 'Live',
  columns: [
    { width: 70, widgets: [{ plugin: 'queue', widget: 'list' }] },
    { width: 30, widgets: [] },
  ],
};

function setup() {
  const sqlite = openDatabase(':memory:');
  let now = 1000;
  const store = new UserStore(sqlite, { now: () => now });
  return { sqlite, store, tick: () => (now += 1) };
}

describe('UserStore', () => {
  it('returns default preferences until the user saves some, per user', () => {
    const { store } = setup();
    expect(store.preferences('a')).toEqual({
      darkScheme: 'rose',
      lightScheme: 'light',
      mode: 'system',
      density: 'comfortable',
      activePreset: null,
    });
    store.setPreferences('a', { ...store.preferences('a'), mode: 'dark', density: 'compact' });
    expect(store.preferences('a')).toMatchObject({ mode: 'dark', density: 'compact' });
    expect(store.preferences('b').mode).toBe('system');
  });

  it('falls back to defaults when stored preferences are unreadable', () => {
    const { sqlite, store } = setup();
    sqlite
      .prepare('INSERT INTO petalbot_user_preferences (user_id, value) VALUES (?, ?)')
      .run('a', '{"mode":"sideways"');
    expect(store.preferences('a').mode).toBe('system');
  });

  it('creates, lists, updates and deletes presets of one user only', () => {
    const { store, tick } = setup();
    const first = store.createPreset('a', layout);
    tick();
    const second = store.createPreset('a', { ...layout, name: 'Chill' });
    expect(first).toMatchObject({ name: 'Live', createdAt: 1000, updatedAt: 1000 });
    expect(store.presets('a').map((preset) => preset.name)).toEqual(['Live', 'Chill']);
    expect(store.presets('b')).toEqual([]);
    expect(store.preset('b', first.id)).toBeUndefined();
    tick();
    const updated = store.updatePreset('a', first.id, { ...layout, name: 'Live 2' });
    expect(updated).toMatchObject({
      id: first.id,
      name: 'Live 2',
      createdAt: 1000,
      updatedAt: 1002,
    });
    expect(store.updatePreset('b', first.id, layout)).toBeUndefined();
    expect(store.deletePreset('b', second.id)).toBe(false);
    expect(store.deletePreset('a', second.id)).toBe(true);
    expect(store.presets('a').map((preset) => preset.id)).toEqual([first.id]);
  });

  it('clears the active preset when it is deleted', () => {
    const { store } = setup();
    const preset = store.createPreset('a', layout);
    store.setPreferences('a', { ...store.preferences('a'), activePreset: preset.id });
    store.deletePreset('a', preset.id);
    expect(store.preferences('a').activePreset).toBeNull();
  });

  it(`allows at most ${String(MAX_PRESETS)} presets per user`, () => {
    const { store } = setup();
    for (let index = 0; index < MAX_PRESETS; index += 1) store.createPreset('a', layout);
    expect(() => store.createPreset('a', layout)).toThrow(PresetLimitError);
    expect(store.createPreset('b', layout).name).toBe('Live');
  });
});
