import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderApiDocuments } from '../../src/server/api-docs.ts';

const docsDir = new URL('../../../../docs/api/', import.meta.url);

describe('API documents', () => {
  it('match the code; run `npx -y pnpm@12.10.1 docs:api` after API changes', async () => {
    const documents = await renderApiDocuments();
    for (const [name, content] of Object.entries(documents)) {
      const committed = await readFile(fileURLToPath(new URL(name, docsDir)), 'utf8').catch(
        () => '',
      );
      expect(committed, `docs/api/${name} is out of date: run npx -y pnpm@12.10.1 docs:api`).toBe(
        content,
      );
    }
  });

  it('document every route and message type', async () => {
    const documents = await renderApiDocuments();
    const openapi = JSON.parse(documents['openapi.json']) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining([
        '/auth/login',
        '/auth/callback',
        '/auth/logout',
        '/api/me',
        '/api/plugins',
        '/api/plugins/{id}/enable',
        '/api/plugins/{id}/data',
        '/api/plugins/{id}/settings',
        '/api/overlays',
        '/api/overlays/{id}/rotate',
        '/api/events',
        '/api/logs',
        '/api/me/preferences',
        '/api/me/presets',
        '/api/me/presets/{id}',
      ]),
    );
    const asyncapi = JSON.parse(documents['asyncapi.json']) as {
      asyncapi: string;
      components: { messages: Record<string, unknown> };
    };
    expect(asyncapi.asyncapi).toBe('3.0.0');
    expect(Object.keys(asyncapi.components.messages).sort()).toEqual(
      [
        'event',
        'hello',
        'inspect',
        'inspectEvent',
        'logEntry',
        'logs',
        'overlayConfig',
        'pluginRemoved',
        'pluginState',
        'reply',
        'rpc',
        'subscribe',
        'unsubscribe',
      ].sort(),
    );
  });
});
