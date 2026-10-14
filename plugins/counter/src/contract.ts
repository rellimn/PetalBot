import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';

const value = z.object({ value: z.number().int() });

export const counterContract = defineContract({
  id: 'counter',
  version: '1.0.0',
  events: {
    changed: {
      schema: z.object({ value: z.number().int(), by: z.string() }),
      expose: ['panel', 'overlay'],
    },
  },
  rpc: {
    get: { input: z.object({}), output: value, expose: { panel: 'mod', overlay: true } },
    increment: { input: z.object({}), output: value, expose: { panel: 'mod' } },
    reset: { input: z.object({}), output: value, expose: { panel: 'owner' } },
  },
  overlays: {
    display: {
      config: z.object({
        label: z.string().max(40).default('Count').describe('Shown before the number'),
        size: z.enum(['small', 'medium', 'large']).default('medium'),
      }),
      events: ['counter.changed'],
      rpc: ['counter.get'],
    },
  },
});
