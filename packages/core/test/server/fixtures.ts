import { z } from 'zod';
import { fail, codecs, defineContract, definePlugin, type PanelUser } from '@petalbot/sdk';

import { late, LateResult, timestamp } from '../result-fixture.ts';

export const ownerUser: PanelUser = { id: 'u-owner', name: 'roman', role: 'owner' };
export const modUser: PanelUser = { id: 'u-mod', name: 'mia', role: 'mod' };

export const alertsContract = defineContract({
  id: 'alerts',
  version: '1.0.0',
  settings: z.object({ volume: z.number().min(0).max(100).default(50) }),
  events: {
    shown: { schema: z.object({ text: z.string() }), expose: ['panel', 'overlay'] },
    internal: { schema: z.object({}) },
    stamped: { schema: z.object({ at: codecs.isoDate() }), expose: ['panel'] },
    /** Not encodable for browsers: a one-way transform. */
    broken: { schema: z.object({ n: z.string().transform((s) => s.length) }), expose: ['panel'] },
  },
  rpc: {
    recent: {
      input: z.object({ limit: z.number().int() }),
      output: z.array(z.string()),
      expose: { panel: 'mod', overlay: true },
    },
    clear: {
      input: z.object({}),
      output: z.object({ cleared: z.number() }),
      expose: { panel: 'owner' },
    },
    whoami: {
      input: z.object({}),
      output: z.object({ caller: z.string(), who: z.string(), client: z.unknown() }),
      expose: { panel: 'mod', overlay: true },
    },
    slow: { input: z.object({}), output: z.object({}), expose: { panel: 'mod' } },
    ping: { output: z.literal('pong'), expose: { panel: 'mod' } },
    hidden: { input: z.object({}), output: z.object({}) },
    when: {
      input: z.object({}),
      output: z.object({ at: codecs.isoDate() }),
      expose: { panel: 'mod' },
    },
    late: { output: LateResult, expose: { panel: 'mod' } },
    lengths: {
      input: z.object({}),
      output: z.object({ n: z.string().transform((s) => s.length) }),
      expose: { panel: 'mod' },
    },
  },
  overlays: {
    box: {
      config: z.object({ durationMs: z.number().int().positive().default(5000) }),
      events: ['alerts.shown'],
      rpc: ['alerts.recent', 'alerts.whoami'],
    },
  },
});

export interface AlertsApi {
  shown(text: string): void;
  internal(): void;
  stamped(at: Date): void;
  broken(): void;
}

export interface AlertsOptions {
  readonly onSetup?: (api: AlertsApi) => void;
  /** `alerts.slow` resolves when this does. */
  readonly slow?: Promise<void>;
}

/** Settings, routes, every RPC and a handle to emit events. */
export function alertsPlugin(options: AlertsOptions = {}) {
  return definePlugin(alertsContract, {
    setup(ctx) {
      ctx.http.route(
        'POST',
        '/webhook',
        async (request) => Response.json({ got: await request.text() }),
        { public: true },
      );
      ctx.http.route('GET', '/secret', () => new Response('owner only'), { role: 'owner' });
      ctx.http.route('POST', '/save', () => new Response('saved'));
      options.onSetup?.({
        shown: (text) => {
          ctx.emit('alerts.shown', { text });
        },
        internal: () => {
          ctx.emit('alerts.internal', {});
        },
        stamped: (at) => {
          ctx.emit('alerts.stamped', { at: at.toISOString() });
        },
        broken: () => {
          ctx.emit('alerts.broken', { n: 'abc' });
        },
      });
      return {
        rpc: {
          recent: ({ limit }) => ['a', 'b', 'c'].slice(0, limit),
          clear: () => ({ cleared: 3 }),
          whoami: (_input, { caller, client, who }) => ({ caller, who, client }),
          ping: () => 'pong',
          slow: async () => {
            await (options.slow ?? Promise.resolve());
            return {};
          },
          hidden: () => ({}),
          when: () => ({ at: '2026-10-12T18:30:00.000Z' }),
          late: () => fail(late, { at: timestamp }),
          lengths: () => ({ n: 'abc' }),
        },
      };
    },
  });
}

export const fanContract = defineContract({ id: 'fan', version: '1.0.0' });
export const fanPlugin = definePlugin(fanContract, {
  dependencies: [alertsContract],
  setup: () => undefined,
});
