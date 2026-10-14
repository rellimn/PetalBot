import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import type { ScaffoldOptions } from './args.ts';
import { namesOf } from './names.ts';
import * as templates from './templates.ts';

/** A new plugin's files: relative path -> content, before formatting. */
export function renderPlugin(options: ScaffoldOptions): Map<string, string> {
  const p: templates.TemplateParams = { ...namesOf(options.id), ...options };
  const files = new Map<string, string>([
    ['package.json', templates.packageJson(p)],
    ['tsconfig.json', templates.tsconfigJson(p)],
    ['vite.config.ts', templates.viteConfig()],
    ['vitest.config.ts', templates.vitestConfig(p)],
    ['src/contract.ts', templates.contract(p)],
    ['src/server.ts', p.db ? templates.dbServer(p) : templates.kvServer(p)],
    ['test/server.test.ts', templates.serverTest(p)],
  ]);
  if (p.db) {
    files.set('drizzle.config.ts', templates.drizzleConfig());
    files.set('src/db/schema.ts', templates.dbSchema(p));
  }
  if (p.panel) {
    files.set('src/client.ts', templates.client(p));
    files.set('src/panel.tsx', templates.panel(p));
    files.set('src/panel.module.css', templates.panelCss());
    files.set('test/panel.test.tsx', templates.panelTest(p));
  }
  for (const name of p.overlays) {
    files.set(`src/overlays/${name}.tsx`, templates.overlay(p, name));
    files.set(`src/overlays/${name}.module.css`, templates.overlayCss());
  }
  return files;
}

/**
 * Writes a new plugin into `dir`, each file formatted with the repository's Prettier config.
 * Returns the written paths, relative to `dir`.
 */
export async function writePlugin(dir: string, options: ScaffoldOptions): Promise<string[]> {
  const files = renderPlugin(options);
  for (const [path, content] of files) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    const config = await resolveConfig(file);
    await writeFile(file, await format(content, { ...config, filepath: file }));
  }
  return [...files.keys()];
}
