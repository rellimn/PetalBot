import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreateArgs } from './args.ts';
import { writePlugin } from './scaffold.ts';
import { checkTarget } from './target.ts';

// `pnpm create-plugin <id> [--no-panel] [--db] [--overlay <name>]...`: writes plugins/<id>/,
// installs, generates the first migration (--db) and builds once, so a running `pnpm dev`
// picks the plugin up and enables it.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pnpm = ['-y', 'pnpm@12.10.1'];

function step(title: string, args: readonly string[], cwd: string): void {
  process.stdout.write(`\n> ${title}\n`);
  const result = spawnSync('npx', [...pnpm, ...args], { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`\n${title} failed. Fix the problem, then run it again in ${cwd}.\n`);
    process.exit(result.status ?? 1);
  }
}

let dir: string;
let options: ReturnType<typeof parseCreateArgs>;
try {
  options = parseCreateArgs(process.argv.slice(2));
  dir = checkTarget(join(root, 'plugins'), options.id);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const files = await writePlugin(dir, options);
process.stdout.write(`Created ${relative(root, dir)}/ with ${String(files.length)} files.\n`);
step('pnpm install', ['install'], root);
if (options.db) step('pnpm db:generate --name init', ['run', 'db:generate', '--name', 'init'], dir);
step('pnpm build', ['run', 'build'], dir);
process.stdout.write(
  `\nDone. With \`pnpm dev\` running, ${options.id} starts within a few seconds (dev enables new\n` +
    `plugins). Start with src/contract.ts; docs/plugin-guide.md walks through every file.\n`,
);
