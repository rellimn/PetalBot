import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { codecs } from '../src/codecs.ts';

const roundTrip = (schema: z.ZodType, value: unknown): unknown =>
  z.decode(schema, JSON.parse(JSON.stringify(z.encode(schema, value))) as unknown);

describe('codecs', () => {
  it('carries dates as ISO strings', () => {
    const schema = z.object({ at: codecs.isoDate() });
    const at = new Date('2026-10-12T18:30:00.000Z');
    expect(z.encode(schema, { at })).toEqual({ at: '2026-10-12T18:30:00.000Z' });
    expect(roundTrip(schema, { at })).toEqual({ at });
    expect(z.safeDecode(schema, { at: 'yesterday' }).success).toBe(false);
  });

  it('carries bigints as decimal strings', () => {
    const schema = z.object({ n: codecs.bigintString() });
    expect(z.encode(schema, { n: 12345678901234567890n })).toEqual({ n: '12345678901234567890' });
    expect(roundTrip(schema, { n: -5n })).toEqual({ n: -5n });
    expect(z.safeDecode(schema, { n: '1.5' }).success).toBe(false);
  });
});
