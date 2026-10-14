import { defineConfig } from '@petalbot/core';

// `npx -y pnpm@12.10.1 preview`: the core serves the built panel itself.
export default defineConfig({
  publicUrl: 'http://127.0.0.1:8080',
  listen: { host: '127.0.0.1', port: 8080 },
  dev: true,
  database: 'petalbot.db',
  pluginDirs: ['../../../plugins'],
});
