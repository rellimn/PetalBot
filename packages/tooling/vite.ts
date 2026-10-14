import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { EnvironmentOptions, Plugin, PluginOption, UserConfig } from 'vite';

/** Bare specifiers the panel and the overlay host provide to plugin bundles through an import map. */
export const SHARED_MODULES = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/compiler-runtime',
  'zod',
  '@petalbot/sdk',
  '@petalbot/ui-sdk',
] as const;

/** CommonJS packages: `export *` loses their named exports in Vite dev, so they are listed. */
const COMMONJS: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/compiler-runtime',
]);
const SHIM_PREFIX = 'virtual:petalbot-shared/';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Overlay names, as contracts declare them. */
const OVERLAY_NAME = /^[a-z][a-z0-9-]*$/;
/** Watch mode: how long every build must have been idle before the marker is written. */
const MARKER_QUIET_MS = 50;

/**
 * Written after every complete build (also after each `--watch` rebuild). The core discovers the
 * plugin's entries from it, and with `dev: true` reloads the plugin when it changes. The core has
 * its own copy of this path and of the shape below.
 */
export const BUILD_MARKER = 'dist/build.json';

/** The content of `dist/build.json`. Entry paths are relative to the plugin folder. */
export interface BuildMarker {
  readonly builtAt: number;
  readonly entries: {
    readonly server?: string;
    readonly panel?: string;
    readonly overlays: Readonly<Record<string, string>>;
  };
}

const isShared = (id: string): boolean => (SHARED_MODULES as readonly string[]).includes(id);

/** plugin-react plus the React Compiler, as every PetalBot UI build uses them. */
export function reactPlugins(): PluginOption[] {
  return [react(), babel({ presets: [reactCompilerPreset()] })];
}

export interface PetalbotPluginOptions {
  /** Server entry, relative to the plugin root. Default `src/server.ts`. */
  readonly server?: string;
  /** Panel entry. Default `src/panel.tsx`. Skipped when the file does not exist. */
  readonly panel?: string;
  /** Folder of overlay entries: each `<name>.tsx` in it is one overlay. Default `src/overlays`. */
  readonly overlays?: string;
}

/** The overlays in `dir`: names of its `.tsx` files, sorted. Throws on names contracts can't use. */
export function overlayEntries(root: string, dir: string): string[] {
  const folder = resolve(root, dir);
  if (!existsSync(folder)) return [];
  const names: string[] = [];
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.tsx')) continue;
    const name = file.slice(0, -'.tsx'.length);
    if (!OVERLAY_NAME.test(name)) {
      throw new Error(
        `petalbot: ${dir}/${file}: overlay file names must match ${String(OVERLAY_NAME)}`,
      );
    }
    names.push(name);
  }
  return names.sort();
}

const overlayEnvironment = (name: string): string => `overlay_${name.replaceAll('-', '_')}`;

/** A browser library build: one ES module plus one stylesheet; shared modules come from the host. */
function browserEnvironment(
  mode: string,
  entry: string,
  outDir: string,
  name: string,
): EnvironmentOptions {
  return {
    consumer: 'client',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
    },
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      lib: { entry, formats: ['es'], fileName: () => `${name}.js`, cssFileName: name },
      rolldownOptions: { external: (id) => isShared(id) },
    },
  };
}

/**
 * Vite preset for plugins. One `vite build` writes:
 * - `dist/panel/panel.js` (+ `panel.css`) from the panel entry, if it exists
 * - `dist/overlays/<name>/<name>.js` (+ `<name>.css`) for every overlay entry
 * - `dist/server/server.js`: one file with the plugin's own modules inlined (a reload re-imports
 *   only the entry) and its package dependencies kept external
 * - `dist/build.json` once all of them are written
 */
export function petalbotPlugin(options: PetalbotPluginOptions = {}): PluginOption[] {
  const serverEntry = options.server ?? 'src/server.ts';
  const panelEntry = options.panel ?? 'src/panel.tsx';
  const overlayDir = options.overlays ?? 'src/overlays';
  let root = process.cwd();
  // Watch mode: environments rebuild independently; the marker waits until none is busy and
  // every one's last build succeeded.
  const building = new Set<string>();
  const failed = new Set<string>();
  let written = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set in `config` from the entries that exist; the marker lists them.
  let entries: BuildMarker['entries'] = { overlays: {} };

  const writeMarker = async (): Promise<void> => {
    const file = resolve(root, BUILD_MARKER);
    await mkdir(dirname(file), { recursive: true });
    const marker: BuildMarker = { builtAt: Date.now(), entries };
    await writeFile(file, `${JSON.stringify(marker)}\n`);
  };

  const plugin: Plugin = {
    name: 'petalbot:plugin',
    config(config, env): UserConfig {
      root = resolve(config.root ?? process.cwd());
      const external = externalsOf(root);
      const overlays = overlayEntries(root, overlayDir);
      const hasPanel = existsSync(resolve(root, panelEntry));
      const hasServer = existsSync(resolve(root, serverEntry));
      entries = {
        ...(hasServer ? { server: 'dist/server/server.js' } : {}),
        ...(hasPanel ? { panel: 'dist/panel/panel.js' } : {}),
        overlays: Object.fromEntries(
          overlays.map((name) => [name, `dist/overlays/${name}/${name}.js`]),
        ),
      };
      const builds = [
        ...(hasPanel ? ['client'] : []),
        ...overlays.map(overlayEnvironment),
        ...(hasServer ? ['server'] : []),
      ];
      return {
        builder: {
          async buildApp(builder) {
            for (const name of builds) {
              const environment = builder.environments[name];
              if (environment) await builder.build(environment);
            }
            // With --watch the loop above only starts watchers; the hooks below write the marker.
            if (!builder.config.build.watch) await writeMarker();
          },
        },
        environments: {
          client: browserEnvironment(env.mode, panelEntry, 'dist/panel', 'panel'),
          ...Object.fromEntries(
            overlays.map((name) => [
              overlayEnvironment(name),
              browserEnvironment(
                env.mode,
                `${overlayDir}/${name}.tsx`,
                `dist/overlays/${name}`,
                name,
              ),
            ]),
          ),
          server: {
            consumer: 'server',
            build: {
              outDir: 'dist/server',
              emptyOutDir: true,
              ssr: true,
              rolldownOptions: {
                input: { server: serverEntry },
                output: { entryFileNames: '[name].js', format: 'es' },
                external,
              },
            },
          },
        },
      };
    },
    buildStart() {
      if (!this.meta.watchMode) return;
      building.add(this.environment.name);
      clearTimeout(timer);
    },
    buildEnd(error) {
      if (!this.meta.watchMode) return;
      if (error) failed.add(this.environment.name);
      else failed.delete(this.environment.name);
    },
    writeBundle() {
      if (this.meta.watchMode) written = true;
    },
    closeBundle() {
      if (!this.meta.watchMode) return;
      building.delete(this.environment.name);
      if (building.size > 0 || failed.size > 0 || !written) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (building.size > 0) return;
        written = false;
        void writeMarker();
      }, MARKER_QUIET_MS);
    },
  };
  return [...reactPlugins(), plugin];
}

/** Package dependencies and Node built-ins stay external in server bundles. */
function externalsOf(root: string): (id: string) => boolean {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  return (id) =>
    id.startsWith('node:') ||
    builtinModules.includes(id) ||
    names.some((name) => id === name || id.startsWith(`${name}/`));
}

const chunkName = (specifier: string): string => `shared/${specifier.replaceAll('/', '_')}`;

/**
 * For the panel and the overlay host: serves one shim module per shared specifier and writes the
 * import map that points plugin bundles at them, so plugins use the host's React, zod and SDK
 * instances. URLs respect Vite's `base` (the overlay host lives under `/overlay/_/`).
 */
export function sharedModulesHost(): Plugin {
  let root = process.cwd();
  let base = '/';
  let isBuild = false;
  return {
    name: 'petalbot:shared-modules-host',
    config(_config, env) {
      if (env.command !== 'build') return undefined;
      return {
        build: {
          rolldownOptions: {
            input: {
              index: 'index.html',
              ...Object.fromEntries(
                SHARED_MODULES.map((specifier) => [chunkName(specifier), SHIM_PREFIX + specifier]),
              ),
            },
            preserveEntrySignatures: 'exports-only',
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
      base = config.base;
      isBuild = config.command === 'build';
    },
    resolveId(id) {
      return id.startsWith(SHIM_PREFIX) ? `\0${id}` : undefined;
    },
    load(id) {
      return id.startsWith(`\0${SHIM_PREFIX}`)
        ? shimSource(id.slice(SHIM_PREFIX.length + 1), root)
        : undefined;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const imports: Record<string, string> = {};
        for (const specifier of SHARED_MODULES) {
          if (!isBuild) {
            imports[specifier] = `${base}@id/__x00__${SHIM_PREFIX}${specifier}`;
            continue;
          }
          const name = chunkName(specifier);
          const chunk = Object.values(ctx.bundle ?? {}).find(
            (output) => output.type === 'chunk' && output.isEntry && output.name === name,
          );
          if (!chunk) throw new Error(`petalbot: no chunk for the shared module "${specifier}"`);
          imports[specifier] = `${base}${chunk.fileName}`;
        }
        return [
          {
            tag: 'script',
            attrs: { type: 'importmap' },
            children: JSON.stringify({ imports }),
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

function shimSource(specifier: string, root: string): string {
  if (!COMMONJS.has(specifier)) return `export * from '${specifier}';\n`;
  const require = createRequire(resolve(root, 'package.json'));
  const names = Object.keys(require(specifier) as object).filter(
    (name) => IDENTIFIER.test(name) && name !== 'default',
  );
  return [
    `import * as m from '${specifier}';`,
    'const d = m.default ?? m;',
    'export default d;',
    ...names.map((name) => `export const ${name} = d.${name};`),
    '',
  ].join('\n');
}
