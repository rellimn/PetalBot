import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { DisposerScope, once } from '../src/disposer-scope.ts';
import { ownerOf, splitName } from '../src/names.ts';
import { withTimeout } from '../src/timeout.ts';
import { parseOrThrow } from '../src/validate.ts';
import { counterContract, createMemoryLogger, delay } from './helpers.ts';

describe('names', () => {
  it('splits at the first dot', () => {
    expect(splitName('chat.message')).toEqual(['chat', 'message']);
    expect(ownerOf('chat.message')).toBe('chat');
  });

  it.each(['chat', '.message', 'chat.', ''])('rejects %j', (name) => {
    expect(splitName(name)).toBeUndefined();
  });
});

describe('parseOrThrow', () => {
  it('returns parsed data', () => {
    expect(parseOrThrow(z.object({ n: z.coerce.number() }), { n: '2' }, 'x')).toEqual({ n: 2 });
  });

  it('throws ValidationError naming the subject', () => {
    expect(() => parseOrThrow(z.number(), 'x', 'input of "a.b"')).toThrow(/Invalid input of "a.b"/);
    expect(() => parseOrThrow(z.number(), 'x', 'y')).toThrow(ValidationError);
  });
});

describe('withTimeout', () => {
  it('resolves when the task is faster', async () => {
    await expect(withTimeout(Promise.resolve(1), 50, () => new Error('slow'))).resolves.toBe(1);
  });

  it('rejects with the timeout error when the task is slower', async () => {
    await expect(withTimeout(delay(100), 10, () => new Error('slow'))).rejects.toThrow('slow');
  });
});

describe('DisposerScope', () => {
  it('runs disposers once, in reverse order, and logs failures', async () => {
    const logger = createMemoryLogger();
    const scope = new DisposerScope(logger);
    const calls: string[] = [];
    scope.add(() => {
      calls.push('first');
    });
    scope.add(() => {
      throw new Error('broken');
    });
    scope.add(async () => {
      await delay(1);
      calls.push('third');
    });
    await scope.dispose();
    await scope.dispose();
    expect(calls).toEqual(['third', 'first']);
    expect(logger.entries).toEqual([
      { level: 'error', message: 'Disposer failed', data: { error: 'broken' } },
    ]);
  });

  it('runs disposers added after dispose immediately and reports being closed', async () => {
    const scope = new DisposerScope(createMemoryLogger());
    expect(scope.closed).toBe(false);
    await scope.dispose();
    expect(scope.closed).toBe(true);
    let ran = false;
    scope.add(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('abandons a disposer that does not finish in time and runs the rest', async () => {
    const logger = createMemoryLogger();
    const scope = new DisposerScope(logger, { timeoutMs: 20 });
    const calls: string[] = [];
    scope.add(() => {
      calls.push('first');
    });
    scope.add(() => new Promise<void>(() => undefined));
    await scope.dispose();
    expect(calls).toEqual(['first']);
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Disposer failed',
      data: { error: 'disposer timed out after 20 ms' },
    });
  });

  it('once() only runs the first call', () => {
    let count = 0;
    const fn = once(() => {
      count += 1;
    });
    fn();
    fn();
    expect(count).toBe(1);
  });
});

describe('ContractRegistry', () => {
  it('looks up members of registered contracts with their owner', () => {
    const registry = new ContractRegistry();
    registry.register(counterContract);
    expect(registry.event('counter.ticked')?.owner).toBe('counter');
    expect(registry.hook('counter.beforeTick')?.def).toBe(counterContract.hooks.beforeTick);
    expect(registry.rpc('counter.double')?.def).toBe(counterContract.rpc.double);
    expect(registry.event('counter.nope')).toBeUndefined();
    expect(registry.event('counter.toString')).toBeUndefined();
    expect(registry.event('other.ticked')).toBeUndefined();
  });

  it('rejects duplicate registration and unregisters', () => {
    const registry = new ContractRegistry();
    const unregister = registry.register(counterContract);
    expect(() => registry.register(counterContract)).toThrow(/already registered/);
    unregister();
    expect(registry.get('counter')).toBeUndefined();
  });
});
