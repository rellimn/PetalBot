/**
 * The scaffold gate: three scaffolded plugins must typecheck, lint, pass their own tests and
 * build. They're written below this package (.out/), so they resolve the workspace packages
 * through this package's node_modules, the way a plugin in plugins/ does.
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScaffoldOptions } from '../src/args.ts';
import { writePlugin } from '../src/scaffold.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = fileURLToPath(new URL('../', import.meta.url));
const out = join(pkg, '.out');

const VARIANTS: readonly ScaffoldOptions[] = [
  { id: 'gateui', panel: true, db: false, overlays: ['banner'] },
  { id: 'gate-db', panel: true, db: true, overlays: ['big-ticker'] },
  { id: 'gate-server', panel: false, db: false, overlays: [] },
];

/** The child must not think it runs inside this Vitest (pool ids, NODE_ENV=test). */
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith('VITEST') && name !== 'NODE_ENV' && name !== 'TEST',
  ),
);

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnv });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} failed (${String(code)}):\n${output}`));
    });
  });
}

const node = (script: string, args: readonly string[], cwd: string): Promise<string> =>
  run(process.execPath, [script, ...args], cwd);

const dirOf = (id: string): string => join(out, id);

beforeAll(async () => {
  await rm(out, { recursive: true, force: true });
  for (const variant of VARIANTS) await writePlugin(dirOf(variant.id), variant);
  // What `pnpm create-plugin --db` runs after installing: the first migration.
  await run(
    join(pkg, 'node_modules/.bin/drizzle-kit'),
    ['generate', '--name', 'init'],
    dirOf('gate-db'),
  );
});

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('scaffolded plugins', () => {
  it('typecheck', async () => {
    const tsc = join(repo, 'node_modules/typescript/bin/tsc');
    await Promise.all(
      VARIANTS.map((variant) => node(tsc, ['-p', 'tsconfig.json'], dirOf(variant.id))),
    );
  });

  it('lint clean with the repository config', async () => {
    const eslint = new ESLint({ cwd: repo, ignore: false });
    const results = await eslint.lintFiles(
      VARIANTS.flatMap((variant) => [
        join(dirOf(variant.id), 'src'),
        join(dirOf(variant.id), 'test'),
        join(dirOf(variant.id), '*.ts'),
      ]),
    );
    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) => `${result.filePath}:${String(message.line)} ${message.message}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it('pass their own tests', async () => {
    const vitest = join(repo, 'node_modules/vitest/vitest.mjs');
    for (const variant of VARIANTS) {
      await node(vitest, ['run', '--root', dirOf(variant.id)], dirOf(variant.id));
    }
  });

  it('build, with every entry in the build marker', async () => {
    const vite = join(pkg, 'node_modules/.bin/vite');
    for (const variant of VARIANTS) {
      await run(vite, ['build', '--logLevel', 'warn'], dirOf(variant.id));
      const marker = JSON.parse(
        await readFile(join(dirOf(variant.id), 'dist/build.json'), 'utf8'),
      ) as { entries: unknown };
      expect(marker.entries).toEqual({
        server: 'dist/server/server.js',
        ...(variant.panel ? { panel: 'dist/panel/panel.js' } : {}),
        overlays: Object.fromEntries(
          variant.overlays.map((name) => [name, `dist/overlays/${name}/${name}.js`]),
        ),
      });
    }
  });
});
