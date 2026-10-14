import { describe, expect, it } from 'vitest';
import { createSession, type SessionState } from '../src/app/session.ts';

describe('createSession', () => {
  it('reports each end and resume once', () => {
    const session = createSession();
    const seen: SessionState[] = [];
    session.state.subscribe((state) => {
      seen.push(state);
    });
    session.end();
    session.end();
    expect(session.ended).toBe(true);
    session.resume();
    session.resume();
    expect(seen.map((state) => state.ended)).toEqual([true, false]);
    expect(session.ended).toBe(false);
  });
});
