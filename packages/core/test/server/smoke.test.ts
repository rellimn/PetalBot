import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const config = fileURLToPath(new URL('../fixtures/smoke/petalbot.config.ts', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

describe('cli', () => {
  it(
    'starts from a TypeScript config with plain Node and stops cleanly on SIGTERM',
    { timeout: 30_000 },
    async () => {
      const port = await freePort();
      const child = spawn(process.execPath, [cli], {
        env: {
          ...process.env,
          PETALBOT_CONFIG: config,
          SMOKE_PORT: String(port),
          PETALBOT_SECRET_KEY: randomBytes(32).toString('base64'),
          PETALBOT_DEV_AUTH: 'owner',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => {
          resolve(code);
        });
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      await vi.waitFor(
        () => {
          expect(output).toContain('PetalBot listening');
        },
        { timeout: 15_000, interval: 100 },
      );

      const base = `http://127.0.0.1:${String(port)}`;
      const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      expect(login.status).toBe(302);
      const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
      const me = await fetch(`${base}/api/me`, { headers: { cookie } });
      await expect(me.json()).resolves.toMatchObject({ user: { role: 'owner' }, devAuth: true });
      const hello = await new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
          origin: base,
          headers: { cookie },
        });
        ws.once('message', (data) => {
          resolve(JSON.parse((data as Buffer).toString('utf8')));
          ws.close();
        });
        ws.once('error', reject);
      });
      expect(hello).toMatchObject({ type: 'hello', identity: { kind: 'panel' } });

      child.kill('SIGTERM');
      await expect(exited).resolves.toBe(0);
      expect(output).toContain('PetalBot shutting down');
    },
  );
});
