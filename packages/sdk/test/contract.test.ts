import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  checkContract,
  defineContract,
  type ContractShape,
  type OverlayDef,
} from '../src/contract.ts';
import { Choices, choice } from '../src/choice.ts';
import { Result, defineFailure } from '../src/result.ts';

describe('defineContract', () => {
  it('returns the contract unchanged', () => {
    const contract = { id: 'quotes', version: '1.0.0' } as const;
    expect(defineContract(contract)).toBe(contract);
  });

  it('exports its runtime checks as checkContract', () => {
    expect(() => {
      checkContract({ id: 'quotes', version: '1.0.0' });
    }).not.toThrow();
    expect(() => {
      checkContract({ id: 'Quotes', version: '1.0.0' });
    }).toThrow(/Invalid contract id/);
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

  it('accepts the RPC kinds query and mutation', () => {
    expect(() =>
      defineContract({
        id: 'quotes',
        version: '1.0.0',
        rpc: {
          list: { kind: 'query', output: z.array(z.string()) },
          add: { kind: 'mutation', output: z.object({}) },
          clear: { output: z.object({}) },
        },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown RPC kind', () => {
    // Typed loosely on purpose: plain JS or a cast skips the compile-time check.
    const shape = {
      id: 'quotes',
      version: '1.0.0',
      rpc: { list: { kind: 'read', output: z.array(z.string()) } },
    } as unknown as ContractShape;
    expect(() => defineContract(shape)).toThrow(
      'Invalid kind "read" of RPC "list" in contract "quotes" (expected "query" or "mutation")',
    );
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
  const options = { kind: 'query' as const, output: Choices, expose: { panel: 'mod' as const } };

  it('accepts an own query RPC without input that is exposed to the panel', () => {
    expect(() => defineContract(withChoice('counter.options', { options }))).not.toThrow();
  });

  it.each([
    ['a typo', 'counter.option', { options }],
    ['a foreign RPC', 'chat.options', { options }],
    ['an RPC with input', 'counter.options', { options: { ...options, input: z.object({}) } }],
    [
      'an RPC not exposed to the panel',
      'counter.options',
      { options: { kind: 'query' as const, output: Choices } },
    ],
    [
      'a mutation',
      'counter.options',
      { options: { output: Choices, expose: { panel: 'mod' as const } } },
    ],
  ] as const)('rejects choice() fields whose RPC is not usable: %s', (_case, rpc, defs) => {
    expect(() => defineContract(withChoice(rpc, defs))).toThrow(
      `Widget "value" of contract "counter": field "counter" uses choice("${rpc}"), which must name an own query RPC without input and with expose.panel`,
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

describe('defineContract secrets', () => {
  it('accepts user-settable, internal and keyed secrets', () => {
    const contract = defineContract({
      id: 'twitch',
      version: '1.0.0',
      secrets: {
        clientSecret: { userSettable: true, label: 'Client secret', description: 'From the app' },
        tokens: { schema: z.object({ accessToken: z.string() }), keyed: true },
        plain: {},
      },
    });
    expect(Object.keys(contract.secrets)).toEqual(['clientSecret', 'tokens', 'plain']);
  });

  it.each(['client/secret', 'client.secret', '1st', ''])('rejects secret name %j', (name) => {
    expect(() =>
      defineContract({ id: 'twitch', version: '1.0.0', secrets: { [name]: {} } }),
    ).toThrow(`Invalid secret name "${name}" in contract "twitch"`);
  });

  it('requires a label on user-settable secrets', () => {
    const shape: ContractShape = {
      id: 'twitch',
      version: '1.0.0',
      secrets: { key: { userSettable: true, label: '  ' } },
    };
    expect(() => defineContract(shape)).toThrow(
      'Secret "key" of contract "twitch" is user-settable and needs a label',
    );
  });

  it('allows no schema and no keyed on user-settable secrets', () => {
    const withSchema = {
      id: 'twitch',
      version: '1.0.0',
      secrets: { key: { userSettable: true, label: 'Key', schema: z.string() } },
    } as unknown as ContractShape;
    expect(() => defineContract(withSchema)).toThrow(
      'Secret "key" of contract "twitch" is user-settable, so it is a plain string without a schema',
    );
    const keyed = {
      id: 'twitch',
      version: '1.0.0',
      secrets: { key: { userSettable: true, label: 'Key', keyed: true } },
    } as unknown as ContractShape;
    expect(() => defineContract(keyed)).toThrow(
      'Secret "key" of contract "twitch": keyed user-settable secrets are not supported yet',
    );
  });

  it('requires keyed to be a boolean on internal secrets', () => {
    const shape = {
      id: 'twitch',
      version: '1.0.0',
      secrets: { tokens: { keyed: 'yes' } },
    } as unknown as ContractShape;
    expect(() => defineContract(shape)).toThrow(
      'Secret "tokens" of contract "twitch": keyed must be true or false',
    );
  });
});

describe('defineContract failure codes', () => {
  const missing = defineFailure({ code: 'missing', reason: 'not-found', details: z.object({}) });
  const alsoMissing = defineFailure({ code: 'missing', reason: 'custom', details: z.object({}) });

  it('accepts one definition reused across RPCs and providers', () => {
    const shape: ContractShape = {
      id: 'quotes',
      version: '1.0.0',
      rpc: {
        get: { output: Result(z.object({}), [missing]) },
        remove: { output: Result(z.object({}), [missing]) },
      },
      providers: {
        store: { load: { input: z.object({}), output: Result(z.object({}), [missing]) } },
      },
    };
    expect(() => {
      checkContract(shape);
    }).not.toThrow();
  });

  it('rejects two definitions of one code, also when nested or in a provider', () => {
    const message = 'Failure code "missing" has two definitions in contract "quotes"';
    const top: ContractShape = {
      id: 'quotes',
      version: '1.0.0',
      rpc: {
        get: { output: Result(z.object({}), [missing]) },
        remove: { output: Result(z.object({}), [alsoMissing]) },
      },
    };
    expect(() => {
      checkContract(top);
    }).toThrow(message);
    const nested: ContractShape = {
      id: 'quotes',
      version: '1.0.0',
      rpc: {
        get: { output: Result(z.object({}), [missing]) },
        all: { output: z.record(z.string(), Result(z.object({}), [alsoMissing]).nullable()) },
      },
    };
    expect(() => {
      checkContract(nested);
    }).toThrow(message);
    const provider: ContractShape = {
      id: 'quotes',
      version: '1.0.0',
      rpc: { get: { output: Result(z.object({}), [missing]) } },
      providers: {
        store: { load: { input: z.object({}), output: Result(z.object({}), [alsoMissing]) } },
      },
    };
    expect(() => {
      checkContract(provider);
    }).toThrow(message);
  });
});
