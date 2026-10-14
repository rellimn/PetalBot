import { defineConfig, type Plugin } from 'vite';
import { reactPlugins, sharedModulesHost } from '@petalbot/tooling/vite';
import { isOverlayPage } from './src/location.ts';

/** Dev only: overlay page URLs get the host page (the core does this in production). */
const overlayPages: Plugin = {
  name: 'petalbot:overlay-pages',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (isOverlayPage((request.url ?? '').split('?')[0] ?? '')) {
        request.url = '/overlay/_/index.html';
      }
      next();
    });
  },
};

export default defineConfig({
  // Everything of the host lives below /overlay/_/; plugin ids cannot start with "_".
  base: '/overlay/_/',
  plugins: [...reactPlugins(), sharedModulesHost(), overlayPages],
  // The panel's Vite proxies /overlay here (with ws: true for HMR), so cookies and Origin stay
  // those of the panel.
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { cssCodeSplit: false, sourcemap: true },
});
