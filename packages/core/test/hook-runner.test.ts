import { describe, expect, it } from 'vitest';
import { AccessError, ValidationError } from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { HookRunner } from '../src/hook-runner.ts';
import { counterContract, createMemoryLogger } from './helpers.ts';

function setup(timeoutMs = 50) {
  const contracts = new ContractRegistry();
  contracts.register(counterContract);
  const logger = createMemoryLogger();
  const hooks = new HookRunner({ contracts, logger, timeoutMs });
  return { hooks, logger };
}

const value = (input: unknown): number => (input as { n: number }).n;
const HOOK = 'counter.beforeTick';

describe('HookRunner', () => {
  it('returns the input unchanged without taps', async () => {
    const { hooks } = setup();
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: false,
      value: { n: 1 },
    });
  });

  it('chains modifications by priority, then load order', async () => {
    const { hooks } = setup();
    const calls: string[] = [];
    hooks.tap('b', 1, HOOK, (input) => {
      calls.push('b');
      return { n: value(input) * 10 };
    });
    hooks.tap('a', 0, HOOK, (input) => {
      calls.push('a');
      return { n: value(input) + 1 };
    });
    hooks.tap(
      'c',
      2,
      HOOK,
      (input) => {
        calls.push('c');
        return { n: value(input) + 5 };
      },
      10,
    );
    const result = await hooks.run('counter', HOOK, { n: 1 });
    expect(calls).toEqual(['c', 'a', 'b']);
    expect(result).toEqual({ vetoed: false, value: { n: 70 } });
  });

  it('passes the value through when a handler returns undefined', async () => {
    const { hooks } = setup();
    hooks.tap('a', 0, HOOK, () => undefined);
    await expect(hooks.run('counter', HOOK, { n: 3 })).resolves.toEqual({
      vetoed: false,
      value: { n: 3 },
    });
  });

  it('stops at the first veto', async () => {
    const { hooks } = setup();
    let laterCalled = false;
    hooks.tap('a', 0, HOOK, (_input, { veto }) => veto('nope'));
    hooks.tap('b', 1, HOOK, () => {
      laterCalled = true;
      return undefined;
    });
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: true,
      vetoedBy: 'a',
      reason: 'nope',
    });
    expect(laterCalled).toBe(false);
  });

  it('skips throwing handlers (fail-open) and logs them', async () => {
    const { hooks, logger } = setup();
    hooks.tap('a', 0, HOOK, () => {
      throw new Error('boom');
    });
    hooks.tap('b', 1, HOOK, (input) => ({ n: value(input) + 1 }));
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: false,
      value: { n: 2 },
    });
    expect(logger.entries[0]).toMatchObject({
      message: 'Hook handler failed',
      data: { plugin: 'a', hook: HOOK, error: 'boom' },
    });
  });

  it('skips handlers that time out', async () => {
    const { hooks, logger } = setup(20);
    hooks.tap('a', 0, HOOK, () => new Promise<never>(() => undefined));
    hooks.tap('b', 1, HOOK, (input) => ({ n: value(input) + 1 }));
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: false,
      value: { n: 2 },
    });
    expect(logger.entries[0]?.data).toMatchObject({ plugin: 'a', error: 'timed out after 20 ms' });
  });

  it('skips handlers that return invalid values', async () => {
    const { hooks } = setup();
    hooks.tap('a', 0, HOOK, () => ({ n: 'not a number' }));
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: false,
      value: { n: 1 },
    });
  });

  it('vetoes on handler failure for failClosed hooks', async () => {
    const { hooks } = setup();
    hooks.tap('a', 0, 'counter.strictCheck', () => {
      throw new Error('boom');
    });
    await expect(hooks.run('counter', 'counter.strictCheck', { n: 1 })).resolves.toEqual({
      vetoed: true,
      vetoedBy: 'a',
      reason: 'hook handler failed: boom',
    });
  });

  it('only lets the owner run a hook', async () => {
    const { hooks } = setup();
    await expect(hooks.run('other', HOOK, { n: 1 })).rejects.toBeInstanceOf(AccessError);
    await expect(hooks.run('counter', 'counter.nope', {})).rejects.toBeInstanceOf(AccessError);
  });

  it('validates the initial input', async () => {
    const { hooks } = setup();
    await expect(hooks.run('counter', HOOK, { n: 'x' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('removes taps when disposed', async () => {
    const { hooks } = setup();
    const dispose = hooks.tap('a', 0, HOOK, (input) => ({ n: value(input) + 1 }));
    dispose();
    await expect(hooks.run('counter', HOOK, { n: 1 })).resolves.toEqual({
      vetoed: false,
      value: { n: 1 },
    });
  });
});
