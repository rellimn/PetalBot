import { defineConfig } from '@petalbot/core';

const port = Number(process.env.SMOKE_PORT ?? '0');

export default defineConfig({
  publicUrl: `http://127.0.0.1:${String(port)}`,
  listen: { host: '127.0.0.1', port },
  database: ':memory:',
  pluginDirs: [],
  dev: true,
});
