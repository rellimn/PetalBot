import { readFileSync } from 'node:fs';

const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly devDependencies: Readonly<Record<string, string>>;
};

/**
 * The version range a new plugin gets for `name`: this package's own devDependency, which is the
 * set the gate test typechecks, tests and builds the templates against.
 */
export function versionOf(name: string): string {
  const range = own.devDependencies[name];
  if (range === undefined) {
    throw new Error(`@petalbot/create-plugin has no devDependency "${name}"`);
  }
  return range;
}
