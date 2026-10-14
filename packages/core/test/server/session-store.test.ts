import { describe, expect, it } from 'vitest';
import type { PanelUser } from '@petalbot/sdk';
import { SessionStore } from '../../src/server/auth/session-store.ts';
import { hashToken } from '../../src/server/tokens.ts';
import { openDatabase } from '../../src/storage/database.ts';

const DAY = 24 * 60 * 60 * 1000;
const user: PanelUser = { id: 'u1', name: 'roman', role: 'owner' };

function setup() {
  let now = 1_000_000_000;
  const sqlite = openDatabase(':memory:');
  const store = new SessionStore(sqlite, { now: () => now });
  return {
    store,
    sqlite,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SessionStore', () => {
  it('resolves sessions by token and stores only the token hash', () => {
    const { store, sqlite } = setup();
    const { token, session } = store.create(user);
    expect(store.get(token)).toMatchObject({ id: session.id, user });
    expect(session.id).toBe(hashToken(token));
    const rows = sqlite.prepare('SELECT id FROM petalbot_sessions').all();
    expect(rows).toEqual([{ id: hashToken(token) }]);
    expect(store.get('not-a-token')).toBeUndefined();
  });

  it('expires after 7 idle days but slides while in use', () => {
    const { store, advance } = setup();
    const { token } = store.create(user);
    advance(6 * DAY);
    expect(store.get(token)).toBeDefined();
    advance(6 * DAY);
    expect(store.get(token)).toBeDefined();
    advance(7 * DAY + 1);
    expect(store.get(token)).toBeUndefined();
  });

  it('expires 30 days after login even when in use', () => {
    const { store, advance } = setup();
    const { token } = store.create(user);
    for (let day = 6; day <= 30; day += 6) {
      advance(6 * DAY);
      expect(store.get(token)).toBeDefined();
    }
    advance(1);
    expect(store.get(token)).toBeUndefined();
  });

  it('reports revoked and expired sessions', () => {
    const { store, advance } = setup();
    const revoked: string[] = [];
    store.onRevoke((id) => {
      revoked.push(id);
    });
    const first = store.create(user);
    store.revoke(first.session.id);
    store.revoke(first.session.id);
    expect(store.get(first.token)).toBeUndefined();
    const second = store.create(user);
    advance(8 * DAY);
    expect(store.touch(second.session.id)).toBeUndefined();
    expect(revoked).toEqual([first.session.id, second.session.id]);
  });

  it('purges expired sessions', () => {
    const { store, advance } = setup();
    store.create(user);
    store.create(user);
    advance(8 * DAY);
    const { token } = store.create(user);
    expect(store.purgeExpired()).toBe(2);
    expect(store.get(token)).toBeDefined();
  });
});
