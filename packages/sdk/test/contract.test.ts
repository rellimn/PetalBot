import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineContract, type ContractShape, type OverlayDef } from '../src/contract.ts';
import { Choices, choice } from '../src/choice.ts';

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

describe('defineContract members', () => {
  it('accepts RPCs without input', () => {
    const contract = defineContract({
      id: 'quotes',
      version: '1.0.0',
      rpc: { list: { output: z.array(z.string()) } },
    });
    expect(contract.rpc.list.output).toBeDefined();
  });

  it('rejects a member name used in two groups', () => {
    const shape: ContractShape = {
      id: 'quotes',
      version: '1.0.0',
      events: { added: { schema: z.object({}) } },
      rpc: { added: { output: z.object({}) } },
    };
    expect(() => defineContract(shape)).toThrow(
      'Member name "added" is used in both events and rpc of contract "quotes"',
    );
  });

  it('rejects invalid widget ids', () => {
    const shape: ContractShape = { id: 'quotes', version: '1.0.0', widgets: { Big: {} } };
    expect(() => defineContract(shape)).toThrow(/Invalid widget id "Big" in contract "quotes"/);
  });
});

describe('defineContract choice() fields', () => {
  /** Typed as ContractShape: skips the compile-time check, so the runtime one runs. */
  const withChoice = (rpc: string, rpcDefs: ContractShape['rpc']): ContractShape => ({
    id: 'counter',
    version: '1.0.0',
    ...(rpcDefs ? { rpc: rpcDefs } : {}),
    widgets: { value: { config: z.object({ counter: choice(rpc).describe('Counter') }) } },
  });
  const options = { output: Choices, expose: { panel: 'mod' as const } };

  it('accepts an own RPC without input that is exposed to the panel', () => {
    expect(() => defineContract(withChoice('counter.options', { options }))).not.toThrow();
  });

  it.each([
    ['a typo', 'counter.option', { options }],
    ['a foreign RPC', 'chat.options', { options }],
    ['an RPC with input', 'counter.options', { options: { ...options, input: z.object({}) } }],
    ['an RPC not exposed to the panel', 'counter.options', { options: { output: Choices } }],
  ] as const)('rejects choice() fields whose RPC is not usable: %s', (_case, rpc, defs) => {
    expect(() => defineContract(withChoice(rpc, defs))).toThrow(
      `Widget "value" of contract "counter": field "counter" uses choice("${rpc}"), which must name an own RPC without input and with expose.panel`,
    );
  });

  it('checks settings and overlay configs too', () => {
    const settings: ContractShape = {
      id: 'counter',
      version: '1.0.0',
      settings: z.object({ favorite: choice('counter.nope').optional() }),
    };
    expect(() => defineContract(settings)).toThrow(
      /^Settings of contract "counter": field "favorite"/,
    );
    const overlay: ContractShape = {
      id: 'counter',
      version: '1.0.0',
      overlays: {
        display: { config: z.object({ c: choice('counter.nope') }), events: [], rpc: [] },
      },
    };
    expect(() => defineContract(overlay)).toThrow(
      /^Overlay "display" of contract "counter": field "c"/,
    );
  });
});
