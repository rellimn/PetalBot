import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineContract, type ContractShape, type OverlayDef } from '../src/contract.ts';

describe('defineContract', () => {
  it('returns the contract unchanged', () => {
    const contract = { id: 'quotes', version: '1.0.0' } as const;
    expect(defineContract(contract)).toBe(contract);
  });

  it.each(['Quotes', '1quotes', 'quo.tes', 'quo_tes', ''])('rejects id %j', (id) => {
    expect(() => defineContract({ id, version: '1.0.0' })).toThrow(/Invalid contract id/);
  });

  it.each(['1.0', 'v1.0.0', '1.0.0-beta'])('rejects version %j', (version) => {
    expect(() => defineContract({ id: 'quotes', version })).toThrow(/Invalid version/);
  });

  it('rejects member names containing dots', () => {
    expect(() =>
      defineContract({
        id: 'quotes',
        version: '1.0.0',
        events: { 'added.now': { schema: z.object({}) } },
      }),
    ).toThrow(/Invalid member name "added.now"/);
  });
});
describe('defineContract overlays', () => {
  const stream: ContractShape = defineContract({
    id: 'stream',
    version: '1.0.0',
    events: {
      follow: { schema: z.object({}), expose: ['overlay'] },
      online: { schema: z.object({}), expose: ['panel'] },
    },
    rpc: {
      recent: { input: z.object({}), output: z.object({}), expose: { overlay: true } },
      reset: { input: z.object({}), output: z.object({}), expose: { panel: 'owner' } },
    },
  });

  /** A contract typed as ContractShape skips the compile-time checks, so the runtime ones run. */
  const withOverlay = (overlay: Partial<OverlayDef>, name = 'box'): ContractShape => ({
    id: 'alerts',
    version: '1.0.0',
    events: { shown: { schema: z.object({}), expose: ['overlay'] } },
    overlays: {
      [name]: { dependencies: [stream], config: z.object({}), events: [], rpc: [], ...overlay },
    },
  });

  it('accepts exposed names of the own contract and the overlay dependencies', () => {
    expect(() =>
      defineContract(
        withOverlay({ events: ['stream.follow', 'alerts.shown'], rpc: ['stream.recent'] }),
      ),
    ).not.toThrow();
  });

  it.each([
    [{ events: ['stream.online'] }, '"stream.online", which is not an event exposed to overlays'],
    [{ events: ['stream.missing'] }, '"stream.missing", which is not an event exposed'],
    [{ events: ['stream.follow'], dependencies: [] }, '"stream.follow", which is not an event'],
    [{ rpc: ['stream.reset'] }, '"stream.reset", which is not an RPC exposed to overlays'],
  ])('rejects %o', (overlay, message) => {
    expect(() => defineContract(withOverlay(overlay))).toThrow(message);
  });

  it('rejects overlay names that do not fit into a URL segment', () => {
    expect(() => defineContract(withOverlay({}, 'Alert Box'))).toThrow(
      'Invalid overlay name "Alert Box" in contract "alerts"',
    );
  });
});
