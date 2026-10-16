import type { z } from 'zod';
import type { counterNotFound } from './contract.ts';

export const presentCounterFailure: (
  failure: z.output<typeof counterNotFound.schema>,
) => string = () => 'This counter no longer exists.';
