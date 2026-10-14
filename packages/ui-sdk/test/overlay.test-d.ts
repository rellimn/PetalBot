import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { createOverlayClient } from '../src/client/plugin-client.ts';
import {
  defineOverlay,
  type OverlayConfig,
  type OverlayDefinition,
  type OverlayProps,
} from '../src/overlay.ts';

const stream = defineContract({
  id: 'stream',
  version: '1.0.0',
  events: {
    follow: { schema: z.object({ user: z.string() }), expose: ['panel', 'overlay'] },
    raid: { schema: z.object({ from: z.string(), viewers: z.number() }), expose: ['overlay'] },
  },
  rpc: {
    recent: {
      kind: 'query',
      input: z.object({}),
      output: z.array(z.string()),
      expose: { overlay: true },
    },
  },
});

const alerts = defineContract({
  id: 'alerts',
  version: '1.0.0',
  events: { shown: { schema: z.object({ id: z.string() }), expose: ['overlay'] } },
  rpc: {
    ack: { input: z.object({ id: z.string() }), output: z.object({}), expose: { overlay: true } },
  },
  overlays: {
    box: {
      dependencies: [stream],
      config: z.object({ durationMs: z.number().default(5000), label: z.string().optional() }),
      events: ['stream.follow', 'alerts.shown'],
      rpc: ['stream.recent'],
    },
    ticker: { config: z.object({}), events: [], rpc: ['alerts.ack'] },
  },
});

const bare = defineContract({ id: 'bare', version: '1.0.0' });

describe('createOverlayClient', () => {
  it('types exactly the members the overlay declares', () => {
    const client = createOverlayClient(alerts, 'box');
    expectTypeOf(client.stream.recent).toHaveProperty('useQuery');
    client.stream.follow.useEvent((event) => {
      expectTypeOf(event.payload).toEqualTypeOf<{ user: string }>();
    });
    client.alerts.shown.useEvent(() => undefined);
    // stream.raid is exposed to overlays but not declared for box
    expectTypeOf(client.stream).not.toHaveProperty('raid');
    expectTypeOf(client.stream.recent.call({})).resolves.toEqualTypeOf<string[]>();
    // alerts.ack belongs to the ticker overlay
    expectTypeOf(client.alerts).not.toHaveProperty('ack');

    const ticker = createOverlayClient(alerts, 'ticker');
    expectTypeOf(ticker.alerts.ack).toHaveProperty('useMutation');
    expectTypeOf(ticker.alerts.ack.call({ id: 'x' })).resolves.toEqualTypeOf<
      z.output<typeof alerts.rpc.ack.output>
    >();
    // ticker declares no events
    expectTypeOf(ticker.alerts).not.toHaveProperty('shown');
  });

  it('rejects unknown overlay names and contracts without overlays', () => {
    // @ts-expect-error -- there is no overlay "nope"
    createOverlayClient(alerts, 'nope');
    // @ts-expect-error -- bare declares no overlays
    createOverlayClient(bare, 'box');
    createOverlayClient(alerts, 'box', {
      // @ts-expect-error -- stream.recent needs no mutation options: it is a query
      mutations: { 'stream.recent': { invalidates: [] } },
    });
    createOverlayClient(alerts, 'ticker', {
      queries: {
        // @ts-expect-error -- alerts.ack is a mutation
        'alerts.ack': {},
      },
    });
  });
});

describe('defineOverlay', () => {
  it('types the config prop from the declaration (defaults applied)', () => {
    expectTypeOf<OverlayConfig<typeof alerts, 'box'>>().toEqualTypeOf<{
      durationMs: number;
      label?: string | undefined;
    }>();
    function Box({ config }: OverlayProps<OverlayConfig<typeof alerts, 'box'>>) {
      expectTypeOf(config.durationMs).toEqualTypeOf<number>();
      return null;
    }
    expectTypeOf(
      defineOverlay(alerts, 'box', { component: Box }),
    ).toEqualTypeOf<OverlayDefinition>();
    function Wrong({ config }: OverlayProps<{ other: string }>) {
      expectTypeOf(config.other).toEqualTypeOf<string>();
      return null;
    }
    // @ts-expect-error -- the component expects a different config
    defineOverlay(alerts, 'box', { component: Wrong });
    // @ts-expect-error -- there is no overlay "nope"
    defineOverlay(alerts, 'nope', { component: Box });
  });
});
