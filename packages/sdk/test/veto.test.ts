import { describe, expect, it } from 'vitest';
import { createVeto, isVeto } from '../src/veto.ts';

describe('veto', () => {
  it('round-trips through isVeto', () => {
    const veto = createVeto('blocked word');
    expect(isVeto(veto)).toBe(true);
    expect(veto.reason).toBe('blocked word');
  });

  it('recognises vetoes created by another copy of the SDK', () => {
    expect(isVeto({ [Symbol.for('petalbot.veto')]: true, reason: 'x' })).toBe(true);
  });

  it.each([undefined, null, 'veto', { reason: 'x' }])('does not treat %j as a veto', (value) => {
    expect(isVeto(value)).toBe(false);
  });
});
