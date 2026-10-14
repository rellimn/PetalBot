import { z } from 'zod';
import { definePlugin, type RpcMeta } from '@petalbot/sdk';
import { counterContract } from './contract.ts';

const who = (meta: RpcMeta): string =>
  meta.client?.kind === 'panel' ? meta.client.user.name : meta.caller;

export default definePlugin(counterContract, {
  settings: z.object({
    step: z.number().int().min(1).max(100).default(1).describe('How much one click adds'),
  }),
  kv: { value: z.number().int() },
  rpc: {
    get: async (_input, { ctx }) => ({ value: (await ctx.kv.get('value')) ?? 0 }),
    increment: async (_input, meta) => {
      const { ctx } = meta;
      const value = ((await ctx.kv.get('value')) ?? 0) + ctx.settings.get().step;
      await ctx.kv.set('value', value);
      ctx.emit('counter.changed', { value, by: who(meta) });
      return { value };
    },
    reset: async (_input, meta) => {
      await meta.ctx.kv.set('value', 0);
      meta.ctx.emit('counter.changed', { value: 0, by: who(meta) });
      return { value: 0 };
    },
  },
  setup(ctx) {
    ctx.log.info('Counter ready', { step: ctx.settings.get().step });
  },
});
