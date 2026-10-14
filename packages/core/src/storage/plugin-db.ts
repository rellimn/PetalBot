import { getTableName, is } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { AccessError } from '@petalbot/sdk';
import type { Sqlite } from './database.ts';

export interface PluginDbOptions {
  readonly schema: unknown;
  readonly migrationsFolder: string;
}

export function migrationsTableOf(pluginId: string): string {
  return `petalbot_migrations_${pluginId}`;
}

/** Validates the table prefix, runs the plugin's migrations and returns its drizzle database. */
export function preparePluginDb(
  sqlite: Sqlite,
  pluginId: string,
  options: PluginDbOptions,
): BetterSQLite3Database<Record<string, unknown>> {
  const prefix = `${pluginId}_`;
  const schema = (options.schema ?? {}) as Record<string, unknown>;
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const name = getTableName(value);
    if (!name.startsWith(prefix)) {
      throw new AccessError(`Table "${name}" of plugin "${pluginId}" must start with "${prefix}"`);
    }
  }
  const migrationsTable = migrationsTableOf(pluginId);
  const before = tableNames(sqlite);
  const hadMigrations = before.includes(migrationsTable);
  const lastMigration = hadMigrations
    ? (sqlite
        .prepare<[], { last: number | null }>(
          `SELECT max(rowid) AS last FROM ${quote(migrationsTable)}`,
        )
        .get()?.last ?? 0)
    : 0;
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder, migrationsTable });
  const created = tableNames(sqlite).filter(
    (name) => !before.includes(name) && name !== migrationsTable,
  );
  const foreign = created.filter((name) => !name.startsWith(prefix));
  if (foreign.length > 0) {
    // Undo this run so that a retry is rejected the same way instead of passing.
    dropTables(sqlite, created);
    if (hadMigrations) {
      sqlite
        .prepare<[number]>(`DELETE FROM ${quote(migrationsTable)} WHERE rowid > ?`)
        .run(lastMigration);
    } else {
      dropTables(sqlite, [migrationsTable]);
    }
    throw new AccessError(
      `Migrations of plugin "${pluginId}" created tables outside its prefix: ${foreign.join(', ')}`,
    );
  }
  return db;
}

/** Drops every `<id>_*` table and the plugin's migrations table. */
export function dropPluginTables(sqlite: Sqlite, pluginId: string): string[] {
  const prefix = `${pluginId}_`;
  const migrationsTable = migrationsTableOf(pluginId);
  const names = tableNames(sqlite).filter(
    (name) => name.startsWith(prefix) || name === migrationsTable,
  );
  dropTables(sqlite, names);
  return names;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function dropTables(sqlite: Sqlite, names: readonly string[]): void {
  sqlite.pragma('foreign_keys = OFF');
  try {
    for (const name of names) sqlite.exec(`DROP TABLE IF EXISTS ${quote(name)}`);
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}

function tableNames(sqlite: Sqlite): string[] {
  const rows = sqlite
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}
