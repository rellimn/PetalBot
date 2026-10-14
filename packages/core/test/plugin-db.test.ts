import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { AccessError } from '@petalbot/sdk';
import { openDatabase, type Sqlite } from '../src/storage/database.ts';
import { dropPluginTables, preparePluginDb } from '../src/storage/plugin-db.ts';
import { notes } from './fixtures/notes-db/schema.ts';
import { foreignMigrations, notesMigrations } from './fixtures/paths.ts';

const tables = (sqlite: Sqlite): string[] =>
  (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as {
      name: string;
    }[]
  ).map((row) => row.name);

const notesOptions = { schema: { notes }, migrationsFolder: notesMigrations };

describe('preparePluginDb', () => {
  it('migrates and returns a working drizzle database', () => {
    const sqlite = openDatabase(':memory:');
    const db = preparePluginDb(sqlite, 'notes', notesOptions);
    db.insert(notes).values({ text: 'hello' }).run();
    expect(db.select().from(notes).all()).toEqual([{ id: 1, text: 'hello' }]);
    expect(tables(sqlite)).toContain('petalbot_migrations_notes');
  });

  it('is idempotent across restarts and keeps data', () => {
    const sqlite = openDatabase(':memory:');
    preparePluginDb(sqlite, 'notes', notesOptions).insert(notes).values({ text: 'kept' }).run();
    const again = preparePluginDb(sqlite, 'notes', notesOptions);
    expect(again.select().from(notes).all()).toEqual([{ id: 1, text: 'kept' }]);
  });

  it('rejects schema tables outside the plugin prefix before migrating', () => {
    const sqlite = openDatabase(':memory:');
    const other = sqliteTable('other_items', { id: integer('id') });
    expect(() =>
      preparePluginDb(sqlite, 'notes', { schema: { other }, migrationsFolder: notesMigrations }),
    ).toThrow(AccessError);
    expect(tables(sqlite)).not.toContain('petalbot_migrations_notes');
  });

  it('rejects migrations that create tables outside the prefix', () => {
    const sqlite = openDatabase(':memory:');
    expect(() =>
      preparePluginDb(sqlite, 'notes', { schema: {}, migrationsFolder: foreignMigrations }),
    ).toThrow(/outside its prefix: other_items/);
  });
});

describe('dropPluginTables', () => {
  it("drops only the plugin's tables and its migrations table", () => {
    const sqlite = openDatabase(':memory:');
    preparePluginDb(sqlite, 'notes', notesOptions);
    sqlite.exec('CREATE TABLE other_keep (id integer)');
    expect(dropPluginTables(sqlite, 'notes')).toEqual(['notes_items', 'petalbot_migrations_notes']);
    expect(tables(sqlite)).toEqual([
      'other_keep',
      'petalbot_kv',
      'petalbot_plugin_state',
      'petalbot_secrets',
      'petalbot_settings',
    ]);
  });

  it('keeps rejecting foreign migrations on retry and leaves no foreign tables', () => {
    const sqlite = openDatabase(':memory:');
    const attempt = () =>
      preparePluginDb(sqlite, 'notes', { schema: {}, migrationsFolder: foreignMigrations });
    expect(attempt).toThrow(/outside its prefix: other_items/);
    expect(attempt).toThrow(/outside its prefix: other_items/);
    expect(tables(sqlite)).not.toContain('other_items');
  });
});
