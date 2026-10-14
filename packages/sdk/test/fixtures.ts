import { z } from 'zod';
import { defineContract } from '../src/contract.ts';
import { Result } from '../src/result.ts';

export const chatContract = defineContract({
  id: 'chat',
  version: '1.0.0',
  events: {
    message: { schema: z.object({ text: z.string(), user: z.string() }), expose: ['panel'] },
  },
  hooks: {
    beforeSend: { input: z.object({ text: z.string() }) },
  },
  rpc: {
    send: {
      input: z.object({ text: z.string() }),
      output: Result(z.object({ messageId: z.string() })),
    },
  },
  providers: {
    platform: {
      send: { input: z.object({ text: z.string() }), output: z.object({ messageId: z.string() }) },
      timeout: { input: z.object({ user: z.string(), seconds: z.number() }), output: z.object({}) },
    },
  },
});

export const pointsContract = defineContract({
  id: 'points',
  version: '2.1.0',
  events: {
    changed: { schema: z.object({ userId: z.string(), balance: z.number().int() }) },
  },
  rpc: {
    getBalance: { input: z.object({ userId: z.string() }), output: z.number().int() },
  },
});

export const quotesContract = defineContract({
  id: 'quotes',
  version: '1.0.0',
  events: {
    added: { schema: z.object({ id: z.string(), text: z.string() }) },
  },
  hooks: {
    beforeAdd: { input: z.object({ text: z.string() }) },
  },
  rpc: {
    list: { input: z.object({}), output: z.array(z.object({ id: z.string(), text: z.string() })) },
  },
});

/** A contract with no members at all. */
export const bareContract = defineContract({ id: 'bare', version: '0.1.0' });
