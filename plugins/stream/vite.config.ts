// One `vite build` writes the server entry, the panel and every overlay into dist/, and
// dist/build.json, which tells the core what was built.
import { defineConfig } from 'vite';
import { petalbotPlugin } from '@petalbot/tooling/vite';

export default defineConfig({ plugins: petalbotPlugin() });
