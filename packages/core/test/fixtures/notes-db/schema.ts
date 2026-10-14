import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
});
