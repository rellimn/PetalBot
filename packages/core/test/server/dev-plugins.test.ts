import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineContract, definePlugin } from '@petalbot/sdk';
import { createServices } from '../../src/server/services.ts';
import { createMemoryLogger } from '../helpers.ts';
import { testConfig, writePlugin } from './helpers.ts';

const quotes = definePlugin(defineContract({ id: 'quotes', version: '1.0.0' }), {
  setup: () => undefined,
});

async function servicesWith(dev: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'petalbot-dev-plugins-'));
  await writePlugin(root, 'quotes');
  const services = createServices({
    // A production config needs OIDC; `dev` is the only field this depends on.
    config: { ...testConfig({ pluginDirs: [root] }), dev },
    logger: createMemoryLogger(),
    load: () => Promise.resolve(quotes),
  });
  await services.manager.start();
  return services;
}

describe('plugins seen for the first time', () => {
  it('start enabled with dev: true', async () => {
    const services = await servicesWith(true);
    expect(services.manager.get('quotes')).toMatchObject({ state: 'running', enabled: true });
    await services.close();
  });

  it('start disabled without dev', async () => {
    const services = await servicesWith(false);
    expect(services.manager.get('quotes')).toMatchObject({ state: 'disabled', enabled: false });
    await services.close();
  });
});
