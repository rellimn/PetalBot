import { describe, expect, it } from 'vitest';
import { hasRole, roleFromGroups } from '../src/roles.ts';

describe('roles', () => {
  it('lets owners do everything mods can', () => {
    expect(hasRole('owner', 'mod')).toBe(true);
    expect(hasRole('owner', 'owner')).toBe(true);
    expect(hasRole('mod', 'mod')).toBe(true);
    expect(hasRole('mod', 'owner')).toBe(false);
  });

  it('maps groups to the highest configured role', () => {
    const mapping = { 'petalbot-owners': 'owner', 'petalbot-mods': 'mod' } as const;
    expect(roleFromGroups(['petalbot-mods', 'petalbot-owners'], mapping)).toBe('owner');
    expect(roleFromGroups(['users', 'petalbot-mods'], mapping)).toBe('mod');
    expect(roleFromGroups(['users', 'constructor'], mapping)).toBeUndefined();
  });
});
