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
