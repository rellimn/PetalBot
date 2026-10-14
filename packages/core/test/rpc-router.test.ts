import { describe, expect, it } from 'vitest';
import {
  AccessError,
  PluginUnavailableError,
  RpcTimeoutError,
  ValidationError,
} from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { RpcRouter } from '../src/rpc-router.ts';
import { counterContract, delay } from './helpers.ts';

function setup(timeoutMs = 50) {
  const contracts = new ContractRegistry();
  contracts.register(counterContract);
  return new RpcRouter({ contracts, timeoutMs });
}

describe('RpcRouter', () => {
  it('validates input, passes caller meta and validates output', async () => {
    const rpc = setup();
    let caller = '';
    rpc.register('counter.double', (input: { n: number }, meta) => {
      caller = meta.caller;
      return input.n * 2;
    });
    await expect(rpc.call('quotes', 'counter.double', { n: 21 })).resolves.toBe(42);
    expect(caller).toBe('quotes');
  });

  it('rejects invalid input with ValidationError', async () => {
    const rpc = setup();
    rpc.register('counter.double', () => 0);
    await expect(rpc.call('quotes', 'counter.double', { n: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects invalid handler output naming the output', async () => {
    const rpc = setup();
    rpc.register('counter.double', () => 'nope');
    await expect(rpc.call('quotes', 'counter.double', { n: 1 })).rejects.toThrow(
      /Invalid output of "counter.double"/,
    );
  });

  it('throws PluginUnavailableError when the owner is not running', async () => {
    const rpc = setup();
    await expect(rpc.call('quotes', 'points.getBalance', {})).rejects.toBeInstanceOf(
      PluginUnavailableError,
    );
  });

  it('rejects unknown RPCs of running plugins and malformed names', async () => {
    const rpc = setup();
    await expect(rpc.call('quotes', 'counter.nope', {})).rejects.toBeInstanceOf(AccessError);
    await expect(rpc.call('quotes', 'counter', {})).rejects.toBeInstanceOf(AccessError);
  });

  it('times out slow handlers', async () => {
    const rpc = setup(20);
    rpc.register('counter.double', () => new Promise<never>(() => undefined));
    await expect(rpc.call('quotes', 'counter.double', { n: 1 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );
  });

  it('honours per-call timeouts', async () => {
    const rpc = setup(10);
    rpc.register('counter.double', async () => {
      await delay(30);
      return 2;
    });
    await expect(rpc.call('quotes', 'counter.double', { n: 1 }, { timeoutMs: 200 })).resolves.toBe(
      2,
    );
  });

  it('rejects duplicate registration and unregisters', async () => {
    const rpc = setup();
    const dispose = rpc.register('counter.double', () => 0);
    expect(() => rpc.register('counter.double', () => 0)).toThrow(/already registered/);
    dispose();
    await expect(rpc.call('quotes', 'counter.double', { n: 1 })).rejects.toBeInstanceOf(
      AccessError,
    );
  });
});
