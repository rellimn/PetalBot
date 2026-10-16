import { z } from 'zod';
import { fail } from '@petalbot/sdk';
import { ProviderRegistry } from '../src/provider-registry.ts';
import { late, LateResult, resultContract, timestamp } from './result-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  AccessError,
  PluginUnavailableError,
  RpcTimeoutError,
  ValidationError,
  defineContract,
  type RpcMeta,
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
    let meta: RpcMeta | undefined;
    rpc.register('counter.double', (input: { n: number }, callMeta) => {
      meta = callMeta;
      return input.n * 2;
    });
    await expect(rpc.call('quotes', 'counter.double', { n: 21 })).resolves.toBe(42);
    expect(meta).toEqual({ caller: 'quotes', who: 'quotes' });
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
      PluginUnavailableError,
    );
  });
});

describe('RPC Result boundaries', () => {
  it('decodes failures and forwards decoded provider details through the schema input', async () => {
    const contracts = new ContractRegistry();
    contracts.register(resultContract);
    const providers = new ProviderRegistry({ contracts });
    providers.register('source', 'clock.source', resultContract.providers.source, 'one', {
      read: () => Promise.resolve(fail(late, { at: timestamp })),
    });
    const rpc = new RpcRouter({ contracts, timeoutMs: 1000 });
    rpc.register('clock.read', async () => {
      const decoded = await providers.view('clock.source').get('one')?.call('read', {});
      expect(decoded).toEqual({
        ok: false,
        reason: 'custom',
        error: { code: 'late', at: new Date(timestamp) },
      });
      // The registry's runtime handle is erased; the contract supplies its concrete output.
      return z.encode(LateResult, decoded as z.output<typeof LateResult>);
    });
    await expect(rpc.call('consumer', 'clock.read', undefined)).resolves.toEqual({
      ok: false,
      reason: 'custom',
      error: { code: 'late', at: new Date(timestamp) },
    });
  });

  it.each([
    { ok: false, reason: 'custom', error: { code: 'private', at: timestamp } },
    { ok: false, reason: 'not-found', error: { code: 'late', at: timestamp } },
    { ok: false, reason: 'custom', error: { code: 'late', at: 'invalid' } },
  ])('rejects an invalid handler failure: %j', async (value) => {
    const contracts = new ContractRegistry();
    contracts.register(resultContract);
    const rpc = new RpcRouter({ contracts, timeoutMs: 1000 });
    rpc.register('clock.read', () => value);
    await expect(rpc.call('consumer', 'clock.read', undefined)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("uses the contract's timeout unless the caller passes one", async () => {
    vi.useFakeTimers();
    try {
      const contracts = new ContractRegistry();
      contracts.register(
        defineContract({
          id: 'quotes',
          version: '1.0.0',
          rpc: { slow: { output: z.object({}), timeoutMs: 8000 } },
        }),
      );
      const rpc = new RpcRouter({ contracts });
      rpc.register('quotes.slow', () => new Promise(() => undefined));
      const byContract = rpc.call('other', 'quotes.slow', undefined);
      const settled = vi.fn();
      byContract.catch(settled);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(byContract).rejects.toThrow('timed out after 8000 ms');
      const byCaller = rpc.call('other', 'quotes.slow', undefined, { timeoutMs: 100 });
      const caught = expect(byCaller).rejects.toThrow('timed out after 100 ms');
      await vi.advanceTimersByTimeAsync(100);
      await caught;
    } finally {
      vi.useRealTimers();
    }
  });
});
