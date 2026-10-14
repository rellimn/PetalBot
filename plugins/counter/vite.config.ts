import { defineConfig } from 'vite';
import { petalbotPlugin } from '@petalbot/tooling/vite';

export default defineConfig({ plugins: petalbotPlugin() });
