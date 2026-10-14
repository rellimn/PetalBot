import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  BUILD_MARKER,
  petalbotPlugin,
  sharedModulesHost,
  SHARED_MODULES,
  type PetalbotPluginOptions,
} from '../vite.ts';

const fixture = fileURLToPath(new URL('./fixtures/hello', import.meta.url));

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'petalbot-preset-'));
  await cp(fixture, root, { recursive: true });
  return root;
}

/** `vite build` runs with NODE_ENV=production; Vitest sets 'test', which selects the dev JSX runtime. */
async function inProduction<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

async function build(
  options?: PetalbotPluginOptions,
  prepare?: (root: string) => Promise<void>,
): Promise<string> {
  const root = await copyFixture();
  await prepare?.(root);
  await inProduction(async () => {
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: petalbotPlugin(options),
    });
    await builder.buildApp();
  });
  return root;
}

const importsFrom = (code: string, specifier: string): boolean =>
  new RegExp(`from\\s*["']${specifier.replaceAll('/', '\\/')}["']`).test(code);

async function waitForMarker(file: string, previous: string | undefined): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text !== undefined && text !== previous) return text;
    await delay(100);
  }
  throw new Error('the build marker was not (re)written');
}

describe('petalbotPlugin', () => {
  it('builds a panel bundle that imports shared modules from the host', async () => {
    const root = await build();
    const panel = await readFile(join(root, 'dist/panel/panel.js'), 'utf8');
    expect(importsFrom(panel, 'react')).toBe(true);
    expect(importsFrom(panel, 'react/jsx-runtime')).toBe(true);
    // The React Compiler ran and its runtime stays shared.
    expect(importsFrom(panel, 'react/compiler-runtime')).toBe(true);
    expect(importsFrom(panel, 'zod')).toBe(true);
    expect(panel).not.toContain('require(');
    const css = await readFile(join(root, 'dist/panel/panel.css'), 'utf8');
    expect(css).toContain('var(--pb-radius-sm)');
  });

  it('builds each overlay as its own bundle with its stylesheet', async () => {
    const root = await build();
    const banner = await readFile(join(root, 'dist/overlays/banner/banner.js'), 'utf8');
    expect(banner).toContain('banner from the fixture');
    expect(importsFrom(banner, 'react')).toBe(true);
    expect(importsFrom(banner, 'react/compiler-runtime')).toBe(true);
    const css = await readFile(join(root, 'dist/overlays/banner/banner.css'), 'utf8');
    expect(css).toContain('var(--pb-radius-md)');
    const ticker = await readFile(join(root, 'dist/overlays/ticker-line/ticker-line.js'), 'utf8');
    expect(ticker).toContain('ticker from the fixture');
    expect(ticker).not.toContain('banner from the fixture');
  });

  it('refuses overlay files whose names cannot be overlay names', async () => {
    await expect(
      build(undefined, async (root) => {
        await writeFile(join(root, 'src/overlays/Bad.tsx'), 'export default () => null;');
      }),
    ).rejects.toThrow('src/overlays/Bad.tsx');
  });

  it('builds a single-file server bundle that keeps dependencies external', async () => {
    const root = await build();
    const server = await readFile(join(root, 'dist/server/server.js'), 'utf8');
    expect(importsFrom(server, '@petalbot/sdk')).toBe(true);
    expect(importsFrom(server, 'zod')).toBe(true);
    expect(importsFrom(server, 'node:path')).toBe(true);
    // The contract module is inlined: reloads re-import one file.
    expect(server).toContain('hello from the fixture');
    expect(server).toContain('greeted');
  });

  it('skips the panel when the plugin has no panel entry', async () => {
    const root = await build({ panel: 'src/missing.tsx' });
    expect(existsSync(join(root, 'dist/panel'))).toBe(false);
    expect(existsSync(join(root, 'dist/server/server.js'))).toBe(true);
  });

  it('writes the build marker with the entries once a build is complete', async () => {
    const root = await build();
    const marker = JSON.parse(await readFile(join(root, BUILD_MARKER), 'utf8')) as unknown;
    expect(marker).toEqual({
      builtAt: expect.any(Number) as number,
      entries: {
        server: 'dist/server/server.js',
        panel: 'dist/panel/panel.js',
        overlays: {
          banner: 'dist/overlays/banner/banner.js',
          'ticker-line': 'dist/overlays/ticker-line/ticker-line.js',
        },
      },
    });
  });

  it('leaves entries out of the marker that the plugin does not have', async () => {
    const root = await build({ panel: 'src/missing.tsx', overlays: 'src/none' });
    const marker = JSON.parse(await readFile(join(root, BUILD_MARKER), 'utf8')) as unknown;
    expect(marker).toEqual({
      builtAt: expect.any(Number) as number,
      entries: { server: 'dist/server/server.js', overlays: {} },
    });
  });

  it(
    'rewrites the marker after each watch rebuild, but not after a failed one',
    { timeout: 30_000 },
    async () => {
      const root = await copyFixture();
      const watchers: { close(): Promise<void> }[] = [];
      try {
        await inProduction(async () => {
          const builder = await createBuilder({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: petalbotPlugin(),
            build: { watch: {} },
          });
          // builder.buildApp() would not hand out the watchers; build the environments directly.
          for (const name of ['client', 'server']) {
            const environment = builder.environments[name];
            if (!environment) throw new Error(`no ${name} environment`);
            const result = await builder.build(environment);
            if ('close' in result) watchers.push(result);
          }
        });
        const marker = join(root, BUILD_MARKER);
        const first = await waitForMarker(marker, undefined);
        expect(JSON.parse(first)).toMatchObject({
          entries: { server: 'dist/server/server.js', panel: 'dist/panel/panel.js' },
        });
        const panel = join(root, 'src/panel.tsx');
        const source = await readFile(panel, 'utf8');

        await writeFile(panel, `${source}\nconst = ;\n`);
        await delay(1500);
        expect(await readFile(marker, 'utf8')).toBe(first);

        await writeFile(panel, `${source}\n// fixed\n`);
        expect(await waitForMarker(marker, first)).not.toBe(first);
      } finally {
        await Promise.all(watchers.map((watcher) => watcher.close()));
      }
    },
  );

  it('lists the modules the panel shares', () => {
    expect(SHARED_MODULES).toEqual([
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/compiler-runtime',
      'zod',
      '@petalbot/sdk',
      '@petalbot/ui-sdk',
    ]);
  });
});

describe('sharedModulesHost', () => {
  it('points the import map at shims below the configured base', () => {
    const plugin: Plugin = sharedModulesHost();
    const configResolved = plugin.configResolved as unknown as (config: object) => void;
    configResolved({ root: fixture, base: '/overlay/_/', command: 'serve' });
    const transform = plugin.transformIndexHtml as unknown as {
      handler: (html: string, ctx: object) => { tag: string; children: string }[];
    };
    const [tag] = transform.handler('', {});
    expect(tag?.tag).toBe('script');
    const map = JSON.parse(tag?.children ?? '{}') as { imports: Record<string, string> };
    expect(map.imports.react).toBe('/overlay/_/@id/__x00__virtual:petalbot-shared/react');
    expect(map.imports['@petalbot/ui-sdk']).toBe(
      '/overlay/_/@id/__x00__virtual:petalbot-shared/@petalbot/ui-sdk',
    );
  });
});
