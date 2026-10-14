/**
 * The counter's database table, defined with Drizzle.
 *
 * Runs in Node only: the server imports it, the contract and UI code never do. After changing
 * this file, run `pnpm db:generate` in plugins/counter. drizzle-kit writes a new migration into
 * drizzle/, and the core applies it the next time the plugin starts. Never edit applied
 * migrations; add a new one.
 *
 * Guide: docs/plugin-guide.md#4-the-server.
 * Read next: src/server.ts.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Table names must start with "<plugin id>_". The core refuses anything else, so plugins can't
// touch each other's tables.
export const counters = sqliteTable('counter_counters', {
  id: text('id').primaryKey(),
  // Unique, so two counters can't share a name (create() also checks it, for a friendly error).
  name: text('name').notNull().unique(),
  value: integer('value').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
