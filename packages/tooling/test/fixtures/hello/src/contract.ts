import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';

export const helloContract = defineContract({
  id: 'hello',
  version: '1.0.0',
  events: { greeted: { schema: z.object({ name: z.string() }), expose: ['panel'] } },
});
