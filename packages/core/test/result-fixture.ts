import { z } from 'zod';
import { codecs, defineContract, defineFailure, Result } from '@petalbot/sdk';

export const timestamp = '2026-10-16T10:00:00.000Z';
export const late = defineFailure({
  code: 'late',
  reason: 'custom',
  details: z.object({ at: codecs.isoDate() }),
});
export const LateResult = Result(z.object({}), [late]);
export const resultContract = defineContract({
  id: 'clock',
  version: '1.0.0',
  rpc: { read: { output: LateResult } },
  providers: { source: { methods: { read: { input: z.object({}), output: LateResult } } } },
});
