import Database from 'better-sqlite3';

export type Sqlite = Database.Database;

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS petalbot_plugin_state (
  plugin_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS petalbot_settings (
  plugin_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS petalbot_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
CREATE TABLE IF NOT EXISTS petalbot_secrets (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
`;

/** Opens (or creates) the database file and ensures the core tables exist. */
export function openDatabase(path: string): Sqlite {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(CORE_SCHEMA);
  return sqlite;
}
