import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../src/keyed-lock.ts';

/** A promise plus the function that resolves it. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('KeyedLock', () => {
  it('runs calls with the same key one at a time, in order', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const first = deferred();
    const a = lock.run('k', async () => {
      log.push('a start');
      await first.promise;
      log.push('a end');
      return 'a';
    });
    const b = lock.run('k', () => {
      log.push('b');
      return 'b';
    });
    await Promise.resolve();
    expect(log).toEqual(['a start']);
    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
    expect(log).toEqual(['a start', 'a end', 'b']);
  });

  it('runs different keys in parallel', async () => {
    const lock = new KeyedLock();
    const held = deferred();
    const slow = lock.run('a', () => held.promise);
    await expect(lock.run('b', () => 'b')).resolves.toBe('b');
    held.resolve();
    await slow;
  });

  it('passes errors through and releases the key for the next call', async () => {
    const lock = new KeyedLock();
    const failing = lock.run('k', () => {
      throw new Error('boom');
    });
    const next = lock.run('k', () => 'next');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
    await expect(lock.run('k', () => Promise.reject(new Error('async boom')))).rejects.toThrow(
      'async boom',
    );
    await expect(lock.run('k', () => 'again')).resolves.toBe('again');
  });

  it('rejects waiting calls on close, lets the running one finish and refuses new ones', async () => {
    const lock = new KeyedLock();
    const held = deferred<string>();
    const running = lock.run('k', () => held.promise);
    const waiting = lock.run('k', () => 'never');
    lock.close(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    await expect(lock.run('other', () => 'x')).rejects.toThrow('stopped');
    held.resolve('done');
    await expect(running).resolves.toBe('done');
  });
});
