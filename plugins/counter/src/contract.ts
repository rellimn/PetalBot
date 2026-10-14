/**
 * The counter's contract: everything other code may know about the plugin.
 *
 * Runs everywhere: in Node (the server and other plugins), in the panel and in the overlay
 * host. It therefore imports only zod and @petalbot/sdk, never server code such as the Drizzle
 * schema. Names are always qualified ("counter.changed"), here and everywhere else.
 *
 * Read next: src/db/schema.ts.
 */
import { z } from 'zod';
import { Choices, Result, choice, defineContract } from '@petalbot/sdk';

/**
 * One counter, as clients see it.
 *
 * Deliberately separate from the Drizzle table (src/db/schema.ts): the table is a server detail
 * that can change (new columns, renames) without breaking anyone who depends on this contract.
 * The server maps rows to this shape in one small function (`toCounter`).
 */
export const Counter = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number().int(),
});
export type Counter = z.output<typeof Counter>;

/** The input of every RPC that acts on one counter. */
const CounterRef = z.object({ counter: z.string().min(1).max(64) });

export const counterContract = defineContract({
  id: 'counter',
  // Must equal the package.json version. A breaking change to this contract is a major bump.
  version: '2.0.0',

  // Settings live in the contract, so the panel and the tests see their type. Give every field
  // a default: a fresh install starts without any stored settings.
  settings: z.object({
    step: z.number().int().min(1).max(100).default(1).describe('How much one click adds'),
  }),

  events: {
    // A counter's value changed. Exposed to overlays too, so the OBS display updates live.
    changed: {
      schema: z.object({ counter: z.string(), value: z.number().int(), by: z.string() }),
      expose: ['panel', 'overlay'],
    },
    // Counters were created or removed. Lists refresh when this arrives.
    listChanged: { schema: z.object({}), expose: ['panel'] },
  },

  rpc: {
    // RPCs without `input` take none: callers write ctx.call('counter.list').
    list: { output: z.array(Counter), expose: { panel: 'mod' } },
    // The values behind choice('counter.options') below: [{ value: id, label: name }].
    options: { output: Choices, expose: { panel: 'mod' } },
    // null rather than an error: a widget or overlay may point at a counter deleted since.
    get: {
      input: CounterRef,
      output: Counter.nullable(),
      expose: { panel: 'mod', overlay: true },
    },
    // Result: "not found" is an expected outcome the caller handles, not a crash.
    increment: {
      input: CounterRef,
      output: Result(z.object({ counter: Counter })),
      expose: { panel: 'mod' },
    },
    reset: {
      input: CounterRef,
      output: Result(z.object({ counter: Counter })),
      expose: { panel: 'mod' },
    },
    create: {
      input: z.object({ name: z.string().trim().min(1).max(40) }),
      output: Counter,
      expose: { panel: 'owner' },
    },
    remove: { input: CounterRef, output: Result(z.object({})), expose: { panel: 'owner' } },
  },

  widgets: {
    // One dashboard widget per counter: the user picks which one when placing it.
    value: { config: z.object({ counter: choice('counter.options').describe('Counter') }) },
  },

  overlays: {
    display: {
      config: z.object({
        counter: choice('counter.options').describe('Counter to show'),
        size: z.enum(['small', 'medium', 'large']).default('medium'),
      }),
      // An overlay may only use what it lists here; the server enforces it.
      events: ['counter.changed'],
      rpc: ['counter.get'],
    },
  },
});
