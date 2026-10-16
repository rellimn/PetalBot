import { z } from 'zod';
import { Result } from '../src/result.ts';
import { rateLimitedFailure } from '../src/rate-limiter.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter, type RateLimiterOptions } from '../src/rate-limiter.ts';

const options = (overrides: Partial<RateLimiterOptions> = {}): RateLimiterOptions => ({
  limit: 2,
  windowMs: 1000,
  maxQueue: 5,
  maxWaitMs: 5000,
  safetyFactor: 1,
  ...overrides,
});

/** Schedules a task that records when it started and returns `name`. */
function track() {
  const started: [string, number][] = [];
  const task = (name: string) => () => {
    started.push([name, Date.now()]);
    return name;
  };
  return { started, task };
}

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns failures accepted by explicitly selecting the limiter definition', async () => {
    const limiter = createRateLimiter(options());
    limiter.dispose();
    const failure = await limiter.schedule(() => 'unused');
    const schema = Result(z.object({ value: z.string() }), [rateLimitedFailure]);
    expect(schema.parse(failure)).toEqual(failure);
    expect(Result(z.object({ value: z.string() }), []).safeParse(failure).success).toBe(false);
  });

  it('starts tasks at once while the budget allows and returns their value', async () => {
    const limiter = createRateLimiter(options({ limit: 10, safetyFactor: 0.9 }));
    const { started, task } = track();
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) => limiter.schedule(task(`t${String(i)}`))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]).toEqual({ ok: true, value: 't0' });
    expect(started).toHaveLength(9);
    expect(limiter.stats()).toEqual({ queued: 0, remaining: 0, limit: 10 });
  });

  it('uses floor(limit * safetyFactor), at least 1', () => {
    expect(createRateLimiter(options({ limit: 100, safetyFactor: undefined })).stats()).toEqual({
      queued: 0,
      remaining: 90,
      limit: 100,
    });
    expect(createRateLimiter(options({ limit: 1, safetyFactor: 0.9 })).stats().remaining).toBe(1);
  });

  it('queues FIFO and starts each task when an earlier start leaves the window', async () => {
    const limiter = createRateLimiter(options());
    const { started, task } = track();
    const all = ['a', 'b', 'c', 'd', 'e'].map((name) => limiter.schedule(task(name)));
    expect(started).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
    expect(limiter.stats()).toEqual({ queued: 3, remaining: 0, limit: 2 });
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(started.slice(2)).toEqual([
      ['c', 1000],
      ['d', 1000],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started.slice(4)).toEqual([['e', 2000]]);
    expect((await Promise.all(all)).map((result) => result.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('rejects at once, without running the task, when the queue is full', async () => {
    const limiter = createRateLimiter(options({ limit: 1, maxQueue: 1 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    void limiter.schedule(task('b'));
    const result = await limiter.schedule(task('c'));
    expect(result).toEqual({
      ok: false,
      reason: 'rate-limited',
      error: { code: 'rate-limited' },
      message: 'Rate limited: the queue is full (1 waiting)',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(started.map(([name]) => name)).toEqual(['a', 'b']);
  });

  it('rejects at once when the start is more than maxWaitMs away', async () => {
    const limiter = createRateLimiter(options({ limit: 1, windowMs: 10_000, maxWaitMs: 5000 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    const result = await limiter.schedule(task('b'));
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(result.ok ? '' : result.message).toBe(
      'Rate limited: the next slot is 10000 ms away (at most 5000 ms)',
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started.map(([name]) => name)).toEqual(['a']);
  });

  it('passes task errors through and counts the start', async () => {
    const limiter = createRateLimiter(options());
    await expect(
      limiter.schedule(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limiter.schedule(() => Promise.reject(new Error('later')))).rejects.toThrow(
      'later',
    );
    expect(limiter.stats().remaining).toBe(0);
  });

  it('setLimit starts waiting tasks at once when the limit grows', async () => {
    const limiter = createRateLimiter(options({ limit: 1 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    const b = limiter.schedule(task('b'));
    expect(started).toHaveLength(1);
    limiter.setLimit(2);
    expect(started).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
    expect(await b).toEqual({ ok: true, value: 'b' });
  });

  it('setLimit rejects waiting tasks that can no longer start in time', async () => {
    const limiter = createRateLimiter(options({ maxWaitMs: 1500 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    void limiter.schedule(task('b'));
    const c = limiter.schedule(task('c'));
    const d = limiter.schedule(task('d'));
    limiter.setLimit(1);
    expect(await d).toMatchObject({ ok: false, reason: 'rate-limited' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await c).toEqual({ ok: true, value: 'c' });
    expect(started.map(([name]) => name)).toEqual(['a', 'b', 'c']);
  });

  it('pause starts nothing for ms, even when a wake-up was already scheduled', async () => {
    const limiter = createRateLimiter(options({ limit: 1, maxWaitMs: 5000 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    const b = limiter.schedule(task('b'));
    limiter.pause(3000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started.map(([name]) => name)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(started).toEqual([
      ['a', 0],
      ['b', 3000],
    ]);
    expect(await b).toEqual({ ok: true, value: 'b' });
  });

  it('pause rejects waiting tasks whose maxWaitMs would expire meanwhile', async () => {
    const limiter = createRateLimiter(options({ limit: 1, maxWaitMs: 2000 }));
    const { task } = track();
    void limiter.schedule(task('a'));
    const b = limiter.schedule(task('b'));
    limiter.pause(30_000);
    expect(await b).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(limiter.stats().queued).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects pause(%s)', (ms) => {
    const limiter = createRateLimiter(options({ limit: 1 }));
    expect(() => {
      limiter.pause(ms);
    }).toThrow(new RangeError('pause needs a finite, non-negative ms'));
  });

  it('keeps pausing after a rejected pause', async () => {
    const limiter = createRateLimiter(options({ limit: 5 }));
    const { started, task } = track();
    expect(() => {
      limiter.pause(Number.NaN);
    }).toThrow(RangeError);
    limiter.pause(2000);
    void limiter.schedule(task('a'));
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(started).toEqual([['a', 2000]]);
  });

  it('dispose rejects waiting tasks and everything scheduled later', async () => {
    const limiter = createRateLimiter(options({ limit: 1 }));
    const { started, task } = track();
    void limiter.schedule(task('a'));
    const b = limiter.schedule(task('b'));
    limiter.dispose();
    const stopped = {
      ok: false,
      reason: 'rate-limited',
      error: { code: 'rate-limited' },
      message: 'Limiter stopped',
    };
    expect(await b).toEqual(stopped);
    expect(await limiter.schedule(task('c'))).toEqual(stopped);
    await vi.advanceTimersByTimeAsync(5000);
    expect(started.map(([name]) => name)).toEqual(['a']);
  });

  it.each([
    [{ limit: 0 }, 'limit must be a positive integer'],
    [{ limit: 1.5 }, 'limit must be a positive integer'],
    [{ windowMs: 0 }, 'windowMs must be positive'],
    [{ maxQueue: -1 }, 'maxQueue must be a non-negative integer'],
    [{ maxWaitMs: -1 }, 'maxWaitMs must not be negative'],
    [{ safetyFactor: 0 }, 'safetyFactor must be greater than 0 and at most 1'],
    [{ safetyFactor: 1.1 }, 'safetyFactor must be greater than 0 and at most 1'],
  ])('validates %j', (overrides, message) => {
    expect(() => createRateLimiter(options(overrides))).toThrow(new RangeError(message));
  });
});
