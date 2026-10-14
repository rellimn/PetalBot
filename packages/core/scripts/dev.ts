import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchBuiltPlugins } from './plugin-folders.ts';

// `node packages/core/scripts/dev.ts [--preview]`
// dev:     build plugins once, then one build watcher per plugin (new plugin folders join once
//          they were built, which `pnpm create-plugin` does) + core (:8080) + panel Vite (:5173)
//          + overlay host Vite (:5174)
// preview: build everything, then only the core, serving the built panel (:8080)

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pluginsDir = `${root}plugins`;
const devDir = fileURLToPath(new URL('../dev/', import.meta.url));
const preview = process.argv.includes('--preview');
const pnpm = ['-y', 'pnpm@12.10.1'];

const keyFile = `${devDir}secret-key`;
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
}
const secretKey = readFileSync(keyFile, 'utf8').trim();

const built = spawnSync(
  'npx',
  [...pnpm, '-r', ...(preview ? [] : ['--filter', './plugins/*']), 'build'],
  { cwd: root, stdio: 'inherit' },
);
if (built.status !== 0) process.exit(built.status ?? 1);

const children = new Set<ChildProcess>();
let stopping = false;
let scanTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Children run in their own process group (`detached`), so this also stops what npx and pnpm
 * started below them. Killing only the direct child left Vite running.
 */
function kill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  clearInterval(scanTimer);
  for (const child of children) kill(child);
  setTimeout(() => process.exit(code), 1000).unref();
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** When an essential child exits, everything stops. Default true. */
  readonly essential?: boolean;
}

function run(
  name: string,
  command: string,
  args: string[],
  options: RunOptions = {},
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line !== '') process.stdout.write(`[${name}] ${line}\n`);
      }
    });
  }
  child.on('exit', (code) => {
    children.delete(child);
    process.stdout.write(`[${name}] exited with ${String(code)}\n`);
    if (options.essential !== false) shutdown(code ?? 0);
  });
  children.add(child);
  return child;
}

const watching = new Set<string>();

/** One `vite build --watch` per built plugin folder; a folder whose watcher exited gets a new one. */
function watchPlugins(): void {
  if (stopping) return;
  watchBuiltPlugins(pluginsDir, watching, (dir, exited) => {
    const child = run(`plugin:${basename(dir)}`, 'npx', [...pnpm, 'run', 'dev'], {
      cwd: dir,
      essential: false,
    });
    child.on('exit', exited);
  });
}

process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});

run('core', process.execPath, [`${root}packages/core/src/cli.ts`], {
  env: {
    PETALBOT_CONFIG: `${devDir}${preview ? 'petalbot.preview.config.ts' : 'petalbot.config.ts'}`,
    PETALBOT_SECRET_KEY: secretKey,
    PETALBOT_DEV_AUTH: process.env.PETALBOT_DEV_AUTH ?? 'owner',
  },
});
if (!preview) {
  watchPlugins();
  scanTimer = setInterval(watchPlugins, 1000);
  run('panel', 'npx', [...pnpm, '--filter', '@petalbot/panel', 'dev']);
  run('overlay', 'npx', [...pnpm, '--filter', '@petalbot/overlay', 'dev']);
}
process.stdout.write(
  `\nPetalBot ${preview ? 'preview' : 'dev'}: open ${preview ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:5173'}\n` +
    (preview
      ? 'Rebuilt plugins take effect after Admin › Plugins › Reload.\n\n'
      : 'Rebuilt plugins reload automatically; new plugins start enabled.\n' +
        'New plugin: npx -y pnpm@12.10.1 create-plugin <id>. Overlays: Admin › Overlays.\n\n'),
);
