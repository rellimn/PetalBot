import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyPluginDefinition, ContractShape } from '@petalbot/sdk';
import { errorMessage } from '../names.ts';
import type { DiscoveredPlugin } from './discovery.ts';

let generation = 0;

/** Imports the plugin's server entry (fresh on every call) and checks it against the manifest. */
export async function loadDefinition(plugin: DiscoveredPlugin): Promise<AnyPluginDefinition> {
  const file = resolve(plugin.dir, plugin.manifest.entries.server);
  generation += 1;
  let module: unknown;
  try {
    module = await import(`${pathToFileURL(file).href}?v=${String(generation)}`);
  } catch (error) {
    throw new Error(`${plugin.id}: cannot import ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const definition = (module as { default?: unknown }).default;
  if (!isDefinition(definition)) {
    throw new Error(`${plugin.id}: ${file} must default-export definePlugin(...)`);
  }
  if (definition.contract.id !== plugin.id) {
    throw new Error(
      `${plugin.id}: contract id "${definition.contract.id}" does not match the plugin id`,
    );
  }
  if (definition.contract.version !== plugin.version) {
    throw new Error(
      `${plugin.id}: contract version ${definition.contract.version} does not match the package version ${plugin.version}`,
    );
  }
  checkIds(plugin.id, 'dependencies', definition.dependencies, plugin.manifest.dependencies);
  checkIds(
    plugin.id,
    'optionalDependencies',
    definition.optionalDependencies,
    plugin.manifest.optionalDependencies,
  );
  return definition;
}

function isDefinition(value: unknown): value is AnyPluginDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { contract?: unknown; setup?: unknown };
  const contract = candidate.contract as { id?: unknown; version?: unknown } | undefined;
  return (
    typeof candidate.setup === 'function' &&
    typeof contract === 'object' &&
    typeof contract.id === 'string' &&
    typeof contract.version === 'string'
  );
}

function checkIds(
  pluginId: string,
  field: string,
  inCode: readonly ContractShape[] | undefined,
  inManifest: Readonly<Record<string, string>>,
): void {
  const code = (inCode ?? []).map((contract) => contract.id).sort();
  const manifest = Object.keys(inManifest).sort();
  if (code.join(',') !== manifest.join(',')) {
    throw new Error(
      `${pluginId}: ${field} in code [${code.join(', ')}] do not match the manifest [${manifest.join(', ')}]`,
    );
  }
}
