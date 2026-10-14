import { describe, expect, it } from 'vitest';
import { counterContract } from '../src/contract.ts';

describe('counter contract', () => {
  it('declares the display overlay with defaults and its scope', () => {
    const display = counterContract.overlays.display;
    expect(display.config.parse({})).toEqual({ label: 'Count', size: 'medium' });
    expect(display.config.safeParse({ label: 'x'.repeat(41) }).success).toBe(false);
    expect(display.events).toEqual(['counter.changed']);
    expect(display.rpc).toEqual(['counter.get']);
  });
});
