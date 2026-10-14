import type { Role } from '@petalbot/sdk';

const RANK: Readonly<Record<Role, number>> = { mod: 1, owner: 2 };

/** `owner` includes every `mod` permission. */
export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

/** The highest role any of `groups` maps to; undefined if none is mapped. */
export function roleFromGroups(
  groups: readonly string[],
  mapping: Readonly<Record<string, Role>>,
): Role | undefined {
  let best: Role | undefined;
  for (const group of groups) {
    const role = Object.hasOwn(mapping, group) ? mapping[group] : undefined;
    if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role;
  }
  return best;
}
