import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPlugin } from '../src/plugin-scope.ts';
import { createScheduler } from '../src/scheduler.ts';

describe('createScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const scheduler = () => createScheduler({ pluginId: 'quotes', onError: () => undefined });

  it('runs after() once and can be cancelled', async () => {
    const s = scheduler();
    const runs: string[] = [];
    s.after(100, () => {
      runs.push('a');
    });
    const cancel = s.after(100, () => {
      runs.push('b');
    });
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toEqual(['a']);
  });

  it('repeats every() without overlapping slow runs', async () => {
    const s = scheduler();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const stop = s.every(100, async () => {
      active += 1;
      runs += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 250));
      active -= 1;
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(maxActive).toBe(1);
    expect(runs).toBe(4);
  });

  it('reports task errors attributed to the plugin', async () => {
    const errors: { message: string; plugin: string | undefined }[] = [];
    const s = createScheduler({
      pluginId: 'quotes',
      onError: (error) => {
        errors.push({ message: (error as Error).message, plugin: currentPlugin() });
      },
    });
    s.after(10, () => {
      throw new Error('boom');
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(errors).toEqual([{ message: 'boom', plugin: 'quotes' }]);
  });

  it('runs cron jobs on schedule until stopped', async () => {
    const s = scheduler();
    let runs = 0;
    const stop = s.cron('* * * * * *', () => {
      runs += 1;
    });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(3);
  });

  it('rejects invalid cron expressions synchronously', () => {
    expect(() => scheduler().cron('not a cron', () => undefined)).toThrow();
  });
});
