import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Choices, choice, type Choice } from '../src/choice.ts';
import { defineContract, type RpcKind } from '../src/contract.ts';

describe('choice() in contracts', () => {
  it('accepts own query RPCs without input, with Choices output and expose.panel', () => {
    const contract = defineContract({
      id: 'counter',
      version: '1.0.0',
      settings: z.object({ favorite: choice('counter.options').optional() }),
      rpc: { options: { kind: 'query', output: Choices, expose: { panel: 'mod' } } },
      widgets: {
        value: { config: z.object({ counter: choice('counter.options').describe('C') }) },
      },
      overlays: {
        display: { config: z.object({ counter: choice('counter.options') }), events: [], rpc: [] },
      },
    });
    expectTypeOf(contract.widgets.value.config.shape.counter).toEqualTypeOf<
      Choice<'counter.options'>
    >();
    expectTypeOf(contract.rpc.options.kind).toEqualTypeOf<'query'>();
  });

  it('rejects RPCs with the wrong output', () => {
    // @ts-expect-error -- counter.names returns strings, not Choices
    defineContract({
      id: 'counter',
      version: '1.0.0',
      rpc: { names: { kind: 'query', output: z.array(z.string()), expose: { panel: 'mod' } } },
      widgets: { value: { config: z.object({ counter: choice('counter.names') }) } },
    });
  });

  it('rejects mutations', () => {
    // @ts-expect-error -- counter.options has no kind: 'query'
    defineContract({
      id: 'counter',
      version: '1.0.0',
      rpc: { options: { output: Choices, expose: { panel: 'mod' } } },
      widgets: { value: { config: z.object({ counter: choice('counter.options') }) } },
    });
    // @ts-expect-error -- counter.options is declared as a mutation
    defineContract({
      id: 'counter',
      version: '1.0.0',
      rpc: { options: { kind: 'mutation', output: Choices, expose: { panel: 'mod' } } },
      widgets: { value: { config: z.object({ counter: choice('counter.options') }) } },
    });
  });

  it('rejects RPCs that are not exposed to the panel, take input or do not exist', () => {
    // @ts-expect-error -- not exposed to the panel
    defineContract({
      id: 'counter',
      version: '1.0.0',
      rpc: { options: { kind: 'query', output: Choices } },
      settings: z.object({ favorite: choice('counter.options').default('a') }),
    });
    // @ts-expect-error -- takes input
    defineContract({
      id: 'counter',
      version: '1.0.0',
      rpc: {
        options: { kind: 'query', input: z.object({}), output: Choices, expose: { panel: 'mod' } },
      },
      widgets: { value: { config: z.object({ counter: choice('counter.options') }) } },
    });
    // @ts-expect-error -- unknown RPC
    defineContract({
      id: 'counter',
      version: '1.0.0',
      widgets: { value: { config: z.object({ counter: choice('counter.option') }) } },
    });
  });

  it('allows only the two kinds', () => {
    expectTypeOf<RpcKind>().toEqualTypeOf<'query' | 'mutation'>();
    defineContract({
      id: 'quotes',
      version: '1.0.0',
      // @ts-expect-error -- not an RPC kind
      rpc: { list: { kind: 'read', output: z.string() } },
    });
  });
});
