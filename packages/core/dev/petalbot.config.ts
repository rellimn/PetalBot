import { defineConfig } from '@petalbot/core';

// `npx -y pnpm@12.10.1 dev`: the browser talks to Vite (5173), which proxies to the core (8080).
export default defineConfig({
  publicUrl: 'http://127.0.0.1:5173',
  listen: { host: '127.0.0.1', port: 8080 },
  dev: true,
  database: 'petalbot.db',
  pluginDirs: ['../../../plugins'],
  logLevel: 'debug',
});
