import { fail, defineFailure, Result } from '@petalbot/sdk';
import { late, resultContract, timestamp } from './result-fixture.ts';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  UnsupportedCapabilityError,
  ValidationError,
  defineContract,
} from '@petalbot/sdk';
import { ContractRegistry } from '../src/contract-registry.ts';
import { ProviderRegistry } from '../src/provider-registry.ts';
import { counterContract } from './helpers.ts';

const SLOT = 'counter.sink';
const slotDef = counterContract.providers.sink;
const write = (input: { text: string }) => Promise.resolve({ id: `id-${input.text}` });

describe('ProviderRegistry', () => {
  it('exposes registered providers with their implemented methods', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    const view = registry.view(SLOT);
    expect(view.keys()).toEqual(['twitch:roman']);
    const handle = view.get('twitch:roman');
    expect(handle?.pluginId).toBe('twitch');
    expect(handle?.methods).toEqual(['write']);
    expect(handle?.has('write')).toBe(true);
    expect(handle?.has('flush')).toBe(false);
    await expect(handle?.call('write', { text: 'hi' })).resolves.toEqual({ id: 'id-hi' });
    expect(view.get('youtube:roman')).toBeUndefined();
  });

  it('throws UnsupportedCapabilityError for methods that are not implemented', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    await expect(registry.view(SLOT).get('twitch:roman')?.call('flush', {})).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it('validates provider input and output', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      write: () => Promise.resolve({ wrong: true }),
    });
    const handle = registry.view(SLOT).get('twitch:roman');
    await expect(handle?.call('write', { text: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(handle?.call('write', { text: 'x' })).rejects.toThrow(
      /Invalid output of "twitch:roman" for "counter.sink.write"/,
    );
  });

  it('rejects unknown methods and duplicate keys', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
        shout: () => Promise.resolve({}),
      }),
    ).toThrow(AccessError);
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    expect(() => registry.register('kick', SLOT, slotDef, 'twitch:roman', { write })).toThrow(
      /already registered by "twitch"/,
    );
  });

  it('detects and binds methods of class-based providers', async () => {
    class Sink {
      readonly prefix = 'cls';
      write(input: { text: string }): Promise<{ id: string }> {
        return Promise.resolve({ id: `${this.prefix}-${input.text}` });
      }
    }
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', new Sink());
    const handle = registry.view(SLOT).get('twitch:roman');
    expect(handle?.methods).toEqual(['write']);
    expect(handle?.has('write')).toBe(true);
    await expect(handle?.call('write', { text: 'hi' })).resolves.toEqual({ id: 'cls-hi' });
  });

  it('calls object-literal methods with their object as this', async () => {
    const registry = new ProviderRegistry();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', {
      prefix: 'lit',
      write(this: { prefix: string }, input: { text: string }) {
        return Promise.resolve({ id: `${this.prefix}-${input.text}` });
      },
    });
    await expect(
      registry.view(SLOT).get('twitch:roman')?.call('write', { text: 'hi' }),
    ).resolves.toEqual({ id: 'lit-hi' });
  });

  it('removes providers when disposed', () => {
    const registry = new ProviderRegistry();
    const dispose = registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    dispose();
    expect(registry.view(SLOT).keys()).toEqual([]);
  });

  it("validates against the slot owner's running contract, not the one seen at registration", async () => {
    const contracts = new ContractRegistry();
    const unregister = contracts.register(counterContract);
    const registry = new ProviderRegistry(contracts);
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    unregister();
    contracts.register(
      defineContract({
        ...counterContract,
        providers: {
          sink: {
            ...counterContract.providers.sink,
            write: {
              input: z.object({ text: z.string().min(3) }),
              output: z.object({ id: z.string() }),
            },
          },
        },
      }),
    );
    const handle = registry.view(SLOT).get('twitch:roman');
    await expect(handle?.call('write', { text: 'hi' })).rejects.toBeInstanceOf(ValidationError);
    await expect(handle?.call('write', { text: 'hello' })).resolves.toEqual({ id: 'id-hello' });
  });
});

describe('ProviderRegistry change listeners', () => {
  it('reports added and removed providers of the slot, once each', () => {
    const registry = new ProviderRegistry();
    const changes: unknown[] = [];
    registry.view(SLOT).onChange((change) => changes.push(change));
    registry.view('other.slot').onChange(() => changes.push('wrong slot'));
    const dispose = registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    dispose();
    dispose();
    expect(changes).toEqual([
      { key: 'twitch:roman', pluginId: 'twitch', change: 'added' },
      { key: 'twitch:roman', pluginId: 'twitch', change: 'removed' },
    ]);
  });

  it('stops calling a listener after its disposer ran', () => {
    const registry = new ProviderRegistry();
    const changes: string[] = [];
    const listener = (change: { change: string }) => changes.push(change.change);
    const first = registry.view(SLOT).onChange(listener);
    registry.view(SLOT).onChange(listener);
    first();
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    expect(changes).toEqual(['added']);
  });

  it('reports nothing for a refused registration', () => {
    const registry = new ProviderRegistry();
    const changes: string[] = [];
    registry.register('twitch', SLOT, slotDef, 'twitch:roman', { write });
    registry.view(SLOT).onChange((change) => changes.push(change.change));
    expect(() => registry.register('kick', SLOT, slotDef, 'twitch:roman', { write })).toThrow(
      AccessError,
    );
    expect(changes).toEqual([]);
  });
});

describe('provider Result boundaries', () => {
  it('decodes failures using the running owner contract, including after replacement', async () => {
    const contracts = new ContractRegistry();
    const unregister = contracts.register(resultContract);
    const registry = new ProviderRegistry(contracts);
    registry.register('source', 'clock.source', resultContract.providers.source, 'one', {
      read: () => Promise.resolve(fail(late, { at: timestamp })),
    });
    const handle = registry.view('clock.source').get('one');
    await expect(handle?.call('read', {})).resolves.toEqual({
      ok: false,
      reason: 'custom',
      error: { code: 'late', at: new Date(timestamp) },
    });
    unregister();
    const gone = defineFailure({ code: 'gone', reason: 'not-found', details: z.object({}) });
    contracts.register(
      defineContract({
        ...resultContract,
        providers: {
          source: { read: { input: z.object({}), output: Result(z.object({}), [gone]) } },
        },
      }),
    );
    await expect(handle?.call('read', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    { ok: false, reason: 'custom', error: { code: 'private', at: timestamp } },
    { ok: false, reason: 'not-found', error: { code: 'late', at: timestamp } },
    { ok: false, reason: 'custom', error: { code: 'late', at: 'invalid' } },
  ])('rejects an invalid provider failure: %j', async (value) => {
    const registry = new ProviderRegistry();
    registry.register('source', 'clock.source', resultContract.providers.source, 'one', {
      read: () => Promise.resolve(value),
    });
    await expect(registry.view('clock.source').get('one')?.call('read', {})).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
