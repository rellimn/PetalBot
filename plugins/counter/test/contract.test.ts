/**
 * Contract tests: the parts of the contract that are plain data (defaults, choice fields).
 * Behavior is tested in server.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { choiceOf } from '@petalbot/sdk';
import { counterContract } from '../src/contract.ts';

describe('counter contract', () => {
  it('defaults the step and the overlay size', () => {
    expect(counterContract.settings.parse({})).toEqual({ step: 1 });
    expect(counterContract.overlays.display.config.parse({ counter: 'a' })).toEqual({
      counter: 'a',
      size: 'medium',
    });
  });

  it('lets the widget and the overlay pick a counter from counter.options', () => {
    expect(choiceOf(counterContract.widgets.value.config.shape.counter)).toBe('counter.options');
    expect(choiceOf(counterContract.overlays.display.config.shape.counter)).toBe('counter.options');
  });

  it('declares what the display overlay may use', () => {
    expect(counterContract.overlays.display.events).toEqual(['counter.changed']);
    expect(counterContract.overlays.display.rpc).toEqual(['counter.get']);
  });
});
