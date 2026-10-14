import { describe, expect, it } from 'vitest';
import { PluginHealth } from '../src/plugin-health.ts';

function setup() {
  let now = 0;
  const changes: [string, boolean][] = [];
  const health = new PluginHealth({ threshold: 3, windowMs: 1000, now: () => now });
  health.onChange((id, degraded) => {
    changes.push([id, degraded]);
  });
  return {
    health,
    changes,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('PluginHealth', () => {
  it('marks a plugin degraded after threshold failures within the window', () => {
    const { health, changes, at } = setup();
    health.record('quotes', 'handler');
    health.record('quotes', 'hook');
    expect(health.isDegraded('quotes')).toBe(false);
    at(500);
    health.record('quotes', 'schedule');
    expect(health.isDegraded('quotes')).toBe(true);
    expect(changes).toEqual([['quotes', true]]);
  });

  it('forgets failures older than the window', () => {
    const { health, at } = setup();
    health.record('quotes', 'handler');
    health.record('quotes', 'handler');
    at(1500);
    health.record('quotes', 'handler');
    expect(health.isDegraded('quotes')).toBe(false);
  });

  it('marks a plugin degraded at once on an uncaught error', () => {
    const { health } = setup();
    health.record('quotes', 'uncaught');
    expect(health.isDegraded('quotes')).toBe(true);
  });

  it('reset() clears the state and announces recovery', () => {
    const { health, changes } = setup();
    health.record('quotes', 'uncaught');
    health.reset('quotes');
    health.reset('quotes');
    expect(health.isDegraded('quotes')).toBe(false);
    expect(changes).toEqual([
      ['quotes', true],
      ['quotes', false],
    ]);
  });
});
