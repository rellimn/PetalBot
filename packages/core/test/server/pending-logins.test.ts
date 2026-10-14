import { describe, expect, it } from 'vitest';
import { PendingLogins } from '../../src/server/auth/pending-logins.ts';

const login = (n: number) => ({ verifier: `v${String(n)}`, state: 's', nonce: 'n', returnTo: '/' });

describe('PendingLogins', () => {
  it('hands out each login once', () => {
    const logins = new PendingLogins();
    const key = logins.add(login(1));
    expect(logins.take(key)).toEqual(login(1));
    expect(logins.take(key)).toBeUndefined();
    expect(logins.take('unknown')).toBeUndefined();
  });

  it('forgets logins after ten minutes', () => {
    let now = 0;
    const logins = new PendingLogins({ now: () => now });
    const key = logins.add(login(1));
    now = 10 * 60 * 1000;
    expect(logins.take(key)).toBeUndefined();
  });

  it('evicts the oldest login when full', () => {
    const logins = new PendingLogins({ max: 2 });
    const first = logins.add(login(1));
    const second = logins.add(login(2));
    const third = logins.add(login(3));
    expect(logins.take(first)).toBeUndefined();
    expect(logins.take(second)).toEqual(login(2));
    expect(logins.take(third)).toEqual(login(3));
  });
});
