import { z } from 'zod';
import { defineFailure, fail } from './result.ts';

/** The task was not attempted; operations must opt into this failure explicitly. */
export const rateLimitedFailure = defineFailure({
  code: 'rate-limited',
  reason: 'rate-limited',
  details: z.object({}),
});
export type RateLimited = z.output<typeof rateLimitedFailure.schema>;

export type Scheduled<T> = { readonly ok: true; readonly value: T } | RateLimited;

export interface RateLimiterOptions {
  /** Task starts allowed per window, as the platform documents them. */
  readonly limit: number;
  readonly windowMs: number;
  /** Tasks that may wait for a slot; more are rejected at once. */
  readonly maxQueue: number;
  /** A task whose start would be further away is rejected at once. */
  readonly maxWaitMs: number;
  /** Share of `limit` actually used, leaving room for drift and manual sends. Default 0.9. */
  readonly safetyFactor?: number | undefined;
}

export interface RateLimiterStats {
  readonly queued: number;
  /** Starts left in the current window. */
  readonly remaining: number;
  /** The configured limit (before the safety factor). */
  readonly limit: number;
}

export interface RateLimiter {
  /**
   * Runs `task` when the window allows. Resolves `{ ok: true, value }`, or `rate-limited` without
   * running it; a throwing task rejects with its error.
   */
  schedule<T>(task: () => T | Promise<T>): Promise<Scheduled<T>>;
  /** Resizes the window budget, e.g. after the bot's role changed. */
  setLimit(limit: number): void;
  /** Starts nothing for `ms`, e.g. after the platform reported a rate-limit hit. */
  pause(ms: number): void;
  stats(): RateLimiterStats;
  /** Rejects waiting tasks and every later `schedule`. Call it from `ctx.onDispose`. */
  dispose(): void;
}

interface Waiting {
  readonly start: () => void;
  readonly reject: (message: string) => void;
  /** Latest acceptable start time. */
  readonly deadline: number;
}

const limited = (message: string): RateLimited => fail(rateLimitedFailure, {}, message);

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }
}

function checkOptions(options: RateLimiterOptions, safetyFactor: number): void {
  checkLimit(options.limit);
  if (!(options.windowMs > 0)) throw new RangeError('windowMs must be positive');
  if (!Number.isInteger(options.maxQueue) || options.maxQueue < 0) {
    throw new RangeError('maxQueue must be a non-negative integer');
  }
  if (!(options.maxWaitMs >= 0)) throw new RangeError('maxWaitMs must not be negative');
  if (!(safetyFactor > 0 && safetyFactor <= 1)) {
    throw new RangeError('safetyFactor must be greater than 0 and at most 1');
  }
}

/**
 * Outbound rate limiting for platform plugins (spec §6.6, §23.2). A sliding window over task
 * start times: a task starts only if fewer than the budget started within the last `windowMs`.
 * Tasks wait in FIFO order; a task that would wait too long is rejected at once instead.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const safetyFactor = options.safetyFactor ?? 0.9;
  checkOptions(options, safetyFactor);
  const { windowMs, maxQueue, maxWaitMs } = options;
  let limit = options.limit;
  let pausedUntil = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Start times within the window, oldest first. */
  const starts: number[] = [];
  const queue: Waiting[] = [];

  const budget = (): number => Math.max(1, Math.floor(limit * safetyFactor));

  const prune = (now: number): void => {
    while (starts.length > 0 && (starts[0] ?? now) <= now - windowMs) starts.shift();
  };

  /** The earliest start at or after `earliest`, given the starts in `simulated`. */
  const startAfter = (simulated: readonly number[], earliest: number): number => {
    const blocking = simulated.at(-budget());
    return simulated.length >= budget() && blocking !== undefined
      ? Math.max(earliest, blocking + windowMs)
      : earliest;
  };

  /** When a task behind `ahead` waiting tasks would start. */
  const projectStart = (now: number, ahead: number): number => {
    const simulated = [...starts];
    let at = Math.max(now, pausedUntil);
    for (let index = 0; index <= ahead; index++) {
      at = startAfter(simulated, at);
      simulated.push(at);
    }
    return at;
  };

  const pump = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (disposed) return;
    const now = Date.now();
    prune(now);
    for (;;) {
      const next = queue[0];
      if (next === undefined) return;
      const at = projectStart(now, 0);
      if (at > now) {
        timer = setTimeout(pump, at - now);
        return;
      }
      queue.shift();
      next.start();
    }
  };

  /** Rejects waiting tasks that can no longer start before their deadline, then pumps. */
  const reevaluate = (): void => {
    const now = Date.now();
    prune(now);
    const simulated = [...starts];
    let earliest = Math.max(now, pausedUntil);
    const kept: Waiting[] = [];
    for (const entry of queue) {
      const at = startAfter(simulated, earliest);
      if (at > entry.deadline) {
        entry.reject(`Rate limited: no slot within ${String(maxWaitMs)} ms`);
        continue;
      }
      kept.push(entry);
      simulated.push(at);
      earliest = at;
    }
    queue.splice(0, queue.length, ...kept);
    pump();
  };

  return {
    schedule<T>(task: () => T | Promise<T>): Promise<Scheduled<T>> {
      if (disposed) return Promise.resolve(limited('Limiter stopped'));
      const now = Date.now();
      prune(now);
      const at = projectStart(now, queue.length);
      if (queue.length > 0 || at > now) {
        if (queue.length >= maxQueue) {
          return Promise.resolve(
            limited(`Rate limited: the queue is full (${String(queue.length)} waiting)`),
          );
        }
        if (at - now > maxWaitMs) {
          return Promise.resolve(
            limited(
              `Rate limited: the next slot is ${String(at - now)} ms away (at most ${String(maxWaitMs)} ms)`,
            ),
          );
        }
      }
      return new Promise<Scheduled<T>>((resolve, reject) => {
        const start = (): void => {
          starts.push(Date.now());
          // Settles with the task's value or error; a synchronous throw becomes a rejection.
          new Promise<T>((settle) => {
            settle(task());
          }).then((value) => {
            resolve({ ok: true, value });
          }, reject);
        };
        if (queue.length === 0 && at <= now) {
          start();
          return;
        }
        queue.push({
          start,
          reject: (message) => {
            resolve(limited(message));
          },
          deadline: now + maxWaitMs,
        });
        pump();
      });
    },
    setLimit(next) {
      checkLimit(next);
      limit = next;
      reevaluate();
    },
    pause(ms) {
      // A NaN would stick in pausedUntil and silently disable every later pause.
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('pause needs a finite, non-negative ms');
      }
      if (disposed) return;
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
      reevaluate();
    },
    stats() {
      prune(Date.now());
      return { queued: queue.length, remaining: Math.max(0, budget() - starts.length), limit };
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const entry of queue.splice(0)) entry.reject('Limiter stopped');
    },
  };
}
