import { defineConfig } from 'vite';
import { reactPlugins, sharedModulesHost } from '@petalbot/tooling/vite';

/** Where the core listens in development (see dev/petalbot.config.ts). */
const CORE = process.env.PETALBOT_CORE_URL ?? 'http://127.0.0.1:8080';
/** The overlay host's dev server (packages/overlay-host): it serves /overlay in development. */
const OVERLAY_HOST = process.env.PETALBOT_OVERLAY_HOST_URL ?? 'http://127.0.0.1:5174';

export default defineConfig({
  plugins: [...reactPlugins(), sharedModulesHost()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The browser talks to Vite only, so cookies and the Origin check see one origin.
    proxy: {
      '/api': CORE,
      '/auth': CORE,
      '/plugins': CORE,
      // ws: Vite's HMR socket of the overlay host runs below /overlay/_/ too.
      '/overlay': { target: OVERLAY_HOST, ws: true },
      '/ws': { target: CORE, ws: true },
    },
  },
  build: { cssCodeSplit: false, sourcemap: true },
});
