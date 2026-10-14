import { join } from 'node:path';
import { definePlugin } from '@petalbot/sdk';
import { helloContract } from './contract.ts';

export default definePlugin(helloContract, {
  setup(ctx) {
    ctx.log.info('hello from the fixture', { path: join('a', 'b') });
  },
});
