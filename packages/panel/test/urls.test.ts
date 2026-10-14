import { describe, expect, it } from 'vitest';
import { hasRole } from '../src/app/roles.ts';
import { loginUrl, socketUrl } from '../src/app/urls.ts';

describe('urls and roles', () => {
  it('builds login and socket URLs', () => {
    expect(loginUrl('/p/quotes/list?x=1')).toBe(
      '/auth/login?returnTo=%2Fp%2Fquotes%2Flist%3Fx%3D1',
    );
    expect(socketUrl({ protocol: 'https:', host: 'bot.example.com' })).toBe(
      'wss://bot.example.com/ws',
    );
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:5173' })).toBe('ws://127.0.0.1:5173/ws');
  });

  it('lets owners do everything mods can', () => {
    expect(hasRole('owner', 'mod')).toBe(true);
    expect(hasRole('mod', 'mod')).toBe(true);
    expect(hasRole('mod', 'owner')).toBe(false);
  });
});
