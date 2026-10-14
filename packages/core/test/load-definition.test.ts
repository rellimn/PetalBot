import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from '../src/loader/discovery.ts';
import { loadDefinition } from '../src/loader/load-definition.ts';

async function pluginWith(
  source: string,
  manifest: { dependencies?: Record<string, string> } = {},
): Promise<DiscoveredPlugin> {
  const dir = await mkdtemp(join(tmpdir(), 'petalbot-load-'));
  await writeFile(join(dir, 'server.js'), source);
  return {
    id: 'hello',
    version: '1.2.3',
    dir,
    manifest: {
      id: 'hello',
      apiVersion: 1,
      dependencies: manifest.dependencies ?? {},
      optionalDependencies: {},
    },
    entries: { server: 'server.js', overlays: {} },
  };
}

const definitionSource = (greeting: string, extra = '') => `
export default {
  contract: { id: 'hello', version: '1.2.3' },
  setup() {},
  greeting: '${greeting}',
  ${extra}
};
`;

describe('loadDefinition', () => {
  it('loads and validates the default export', async () => {
    const plugin = await pluginWith(definitionSource('v1'));
    const definition = await loadDefinition(plugin);
    expect(definition.contract).toEqual({ id: 'hello', version: '1.2.3' });
    expect((definition as unknown as { greeting: string }).greeting).toBe('v1');
  });

  it('imports fresh code after the file changed', async () => {
    const plugin = await pluginWith(definitionSource('v1'));
    await loadDefinition(plugin);
    await writeFile(join(plugin.dir, 'server.js'), definitionSource('v2'));
    const definition = await loadDefinition(plugin);
    expect((definition as unknown as { greeting: string }).greeting).toBe('v2');
  });

  it('rejects modules that do not export a plugin definition', async () => {
    const plugin = await pluginWith('export default 42;');
    await expect(loadDefinition(plugin)).rejects.toThrow(
      /hello: .*server\.js must default-export definePlugin\(\.\.\.\)/,
    );
  });

  it('rejects a contract id or version that does not match the package', async () => {
    const wrongId = await pluginWith(definitionSource('x').replace("id: 'hello'", "id: 'other'"));
    await expect(loadDefinition(wrongId)).rejects.toThrow(
      'hello: contract id "other" does not match the plugin id',
    );
    const wrongVersion = await pluginWith(definitionSource('x').replace('1.2.3', '1.0.0'));
    await expect(loadDefinition(wrongVersion)).rejects.toThrow(
      'hello: contract version 1.0.0 does not match the package version 1.2.3',
    );
  });

  it('rejects dependencies that differ from the manifest', async () => {
    const plugin = await pluginWith(definitionSource('x'), { dependencies: { chat: '^1.0.0' } });
    await expect(loadDefinition(plugin)).rejects.toThrow(
      'hello: dependencies in code [] do not match the manifest [chat]',
    );
  });

  it('reports import errors with the file name', async () => {
    const plugin = await pluginWith('export default {');
    await expect(loadDefinition(plugin)).rejects.toThrow(/hello: cannot import .*server\.js/);
  });
});
