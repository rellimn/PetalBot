// drizzle-kit's config: where the schema lives and where `pnpm db:generate` writes migrations.
// The core applies the migrations from ./drizzle when the plugin starts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
