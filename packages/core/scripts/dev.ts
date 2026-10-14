import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `node packages/core/scripts/dev.ts [--preview]`
// dev:     build plugins once, then plugin watchers + core (:8080) + panel Vite (:5173) + overlay host Vite (:5174)
// preview: build everything, then only the core, serving the built panel (:8080)

const root = fileURLToPath(new URL('../../../', import.meta.url));
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

const children: ChildProcess[] = [];
let stopping = false;

function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}

function run(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line !== '') process.stdout.write(`[${name}] ${line}\n`);
      }
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`[${name}] exited with ${String(code)}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});

run('core', process.execPath, [`${root}packages/core/src/cli.ts`], {
  PETALBOT_CONFIG: `${devDir}${preview ? 'petalbot.preview.config.ts' : 'petalbot.config.ts'}`,
  PETALBOT_SECRET_KEY: secretKey,
  PETALBOT_DEV_AUTH: process.env.PETALBOT_DEV_AUTH ?? 'owner',
});
if (!preview) {
  run('plugins', 'npx', [...pnpm, '-r', '--parallel', '--filter', './plugins/*', 'dev']);
  run('panel', 'npx', [...pnpm, '--filter', '@petalbot/panel', 'dev']);
  run('overlay', 'npx', [...pnpm, '--filter', '@petalbot/overlay', 'dev']);
}
process.stdout.write(
  `\nPetalBot ${preview ? 'preview' : 'dev'}: open ${preview ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:5173'}\n` +
    (preview
      ? 'Rebuilt plugins take effect after Admin › Plugins › Reload.\n\n'
      : 'Rebuilt plugins reload automatically. Overlays: Admin › Overlays.\n\n'),
);
