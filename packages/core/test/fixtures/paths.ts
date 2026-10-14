import { fileURLToPath } from 'node:url';

export const notesMigrations = fileURLToPath(new URL('./notes-db/migrations', import.meta.url));
export const foreignMigrations = fileURLToPath(new URL('./foreign-db/migrations', import.meta.url));
export const notesDir = fileURLToPath(new URL('./notes-db', import.meta.url));
