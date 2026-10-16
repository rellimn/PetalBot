import { describe, expect, it } from 'vitest';
import { renderPlugin } from '../src/scaffold.ts';

const files = (options: Partial<Parameters<typeof renderPlugin>[0]> = {}) =>
  [
    ...renderPlugin({ id: 'quotes', panel: true, db: false, overlays: [], ...options }).keys(),
  ].sort();

describe('renderPlugin', () => {
  it('writes a KV plugin with a panel by default', () => {
    expect(files()).toEqual([
      'package.json',
      'src/client.ts',
      'src/contract.ts',
      'src/panel.module.css',
      'src/panel.tsx',
      'src/server.ts',
      'test/panel.test.tsx',
      'test/server.test.ts',
      'tsconfig.json',
      'vite.config.ts',
      'vitest.config.ts',
    ]);
  });

  it('adds the database files with --db and overlays with --overlay, drops the panel with --no-panel', () => {
    expect(files({ panel: false, db: true, overlays: ['box'] })).toEqual([
      'drizzle.config.ts',
      'package.json',
      'src/contract.ts',
      'src/db/schema.ts',
      'src/overlays/box.module.css',
      'src/overlays/box.tsx',
      'src/server.ts',
      'test/server.test.ts',
      'tsconfig.json',
      'vite.config.ts',
      'vitest.config.ts',
    ]);
  });

  it('declares the manifest without entries and only the dependencies the plugin uses', () => {
    const pkg = JSON.parse(
      renderPlugin({ id: 'quotes', panel: false, db: false, overlays: [] }).get('package.json') ??
        '',
    ) as Record<string, unknown>;
    expect(pkg.petalbot).toEqual({ id: 'quotes', apiVersion: 3 });
    expect(Object.keys(pkg.dependencies as object)).toEqual(['@petalbot/sdk', 'zod']);
    expect(Object.keys(pkg.devDependencies as object)).toEqual([
      '@petalbot/testing',
      '@petalbot/tooling',
      'vite',
    ]);
  });
});
