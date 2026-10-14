import type { Role } from '@petalbot/sdk';

/** Owners can do everything mods can. */
export function hasRole(role: Role, minimum: Role): boolean {
  return role === 'owner' || minimum === 'mod';
}
