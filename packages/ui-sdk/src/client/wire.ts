import { z } from 'zod';
import type { ContractShape } from '@petalbot/sdk';
import { ClientError } from './errors.ts';

/** Event payload and RPC output schemas of some contracts, by qualified name. */
export interface WireSchemas {
  readonly events: ReadonlyMap<string, z.ZodType>;
  readonly outputs: ReadonlyMap<string, z.ZodType>;
}

export function wireSchemas(contracts: readonly ContractShape[]): WireSchemas {
  const events = new Map<string, z.ZodType>();
  const outputs = new Map<string, z.ZodType>();
  for (const contract of contracts) {
    for (const [member, def] of Object.entries(contract.events ?? {})) {
      events.set(`${contract.id}.${member}`, def.schema);
    }
    for (const [member, def] of Object.entries(contract.rpc ?? {})) {
      outputs.set(`${contract.id}.${member}`, def.output);
    }
  }
  return { events, outputs };
}

/**
 * Turns what the server encoded back into the contract's types (codecs to their values). Throws
 * ClientError('validation') when it does not match, e.g. a dependency changed incompatibly.
 */
export function decodeWire(
  schema: z.ZodType | undefined,
  value: unknown,
  subject: string,
): unknown {
  if (!schema) return value;
  const result = z.safeDecode(schema, value);
  if (!result.success) {
    throw new ClientError(
      'validation',
      `${subject} does not match the contract: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
