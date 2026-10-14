import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTarget } from '../src/target.ts';

describe('checkTarget', () => {
  it('answers the new folder, and refuses existing folders and used ids', async () => {
    const plugins = await mkdtemp(join(tmpdir(), 'petalbot-target-'));
    await mkdir(join(plugins, 'quotes'));
    await mkdir(join(plugins, 'renamed'));
    await writeFile(
      join(plugins, 'renamed', 'package.json'),
      JSON.stringify({ petalbot: { id: 'alerts' } }),
    );
    expect(checkTarget(plugins, 'fresh')).toBe(join(plugins, 'fresh'));
    expect(() => checkTarget(plugins, 'quotes')).toThrow(
      `${join(plugins, 'quotes')} already exists`,
    );
    expect(() => checkTarget(plugins, 'alerts')).toThrow(
      `The plugin id "alerts" is already used by ${join(plugins, 'renamed')}`,
    );
  });
});
