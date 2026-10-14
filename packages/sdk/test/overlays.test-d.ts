import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '../src/contract.ts';

const streamContract = defineContract({
  id: 'stream',
  version: '1.0.0',
  events: {
    follow: { schema: z.object({ user: z.string() }), expose: ['panel', 'overlay'] },
    online: { schema: z.object({}), expose: ['panel'] },
    hidden: { schema: z.object({}) },
  },
  rpc: {
    recent: {
      input: z.object({}),
      output: z.array(z.string()),
      expose: { panel: 'mod', overlay: true },
    },
    reset: { input: z.object({}), output: z.object({}), expose: { panel: 'owner' } },
  },
});

describe('contract overlays', () => {
  it('accepts exposed names of the own contract and the overlay dependencies', () => {
    const alerts = defineContract({
      id: 'alerts',
      version: '1.0.0',
      events: { shown: { schema: z.object({}), expose: ['overlay'] } },
      overlays: {
        box: {
          dependencies: [streamContract],
          config: z.object({ durationMs: z.number().default(5000) }),
          events: ['stream.follow', 'alerts.shown'],
          rpc: ['stream.recent'],
        },
        ticker: { config: z.object({}), events: ['alerts.shown'], rpc: [] },
      },
    });
    expectTypeOf(alerts.id).toEqualTypeOf<'alerts'>();
    expectTypeOf(alerts.overlays.box.events).toEqualTypeOf<
      readonly ['stream.follow', 'alerts.shown']
    >();
    expectTypeOf<z.input<typeof alerts.overlays.box.config>>().toEqualTypeOf<{
      durationMs?: number | undefined;
    }>();
  });

  it('rejects events that are not exposed to overlays', () => {
    defineContract({
      id: 'a',
      version: '1.0.0',
      overlays: {
        box: {
          dependencies: [streamContract],
          config: z.object({}),
          // @ts-expect-error -- stream.online is exposed to the panel only
          events: ['stream.online'],
          rpc: [],
        },
      },
    });
  });

  it('rejects RPCs that are not exposed to overlays', () => {
    defineContract({
      id: 'a',
      version: '1.0.0',
      overlays: {
        box: {
          dependencies: [streamContract],
          config: z.object({}),
          events: [],
          // @ts-expect-error -- stream.reset is not exposed to overlays
          rpc: ['stream.reset'],
        },
      },
    });
  });

  it('rejects names of contracts that are not overlay dependencies', () => {
    defineContract({
      id: 'a',
      version: '1.0.0',
      overlays: {
        // @ts-expect-error -- stream is not listed in the overlay's dependencies
        box: { config: z.object({}), events: ['stream.follow'], rpc: [] },
      },
    });
  });

  it('rejects unknown names', () => {
    defineContract({
      id: 'a',
      version: '1.0.0',
      overlays: {
        box: {
          dependencies: [streamContract],
          config: z.object({}),
          // @ts-expect-error -- there is no event stream.missing
          events: ['stream.missing'],
          rpc: [],
        },
      },
    });
  });
});
