import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@petalbot/testing';
import counter from '../src/server.ts';

describe('counter plugin', () => {
  it('counts in steps, announces changes and resets', async () => {
    const harness = await createTestHarness(counter, { settings: { step: 5 } });
    await expect(harness.call('counter.get', {})).resolves.toEqual({ value: 0 });
    await expect(harness.call('counter.increment', {})).resolves.toEqual({ value: 5 });
    await expect(harness.call('counter.increment', {})).resolves.toEqual({ value: 10 });
    await harness.idle();
    expect(harness.events.map((event) => event.payload)).toEqual([
      { value: 5, by: 'petalbot-test-caller' },
      { value: 10, by: 'petalbot-test-caller' },
    ]);
    await expect(harness.call('counter.reset', {})).resolves.toEqual({ value: 0 });
    await harness.stop();
  });
});
