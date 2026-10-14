import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { choice } from '@petalbot/sdk';
import { humanize, patchOf, setPath, settingsFields } from '../src/settings/schema.ts';

const schema = z.toJSONSchema(
  z.object({
    volume: z.number().min(0).max(100).default(50).describe('How loud alerts play'),
    enabled: z.boolean().default(true),
    mode: z.enum(['chat', 'whisper']).default('chat'),
    greeting: z.string().max(200).optional(),
    email: z.email().optional(),
    count: z.number().int().default(3),
    banned: z.array(z.string()).default([]),
    limits: z.object({ perMinute: z.number().int().min(1).default(20) }).prefault({}),
    either: z.union([z.string(), z.number()]).optional(),
    title: z.string().meta({ title: 'Stream title' }),
  }),
  { io: 'input', unrepresentable: 'any' },
) as Record<string, unknown>;

describe('settingsFields', () => {
  it('turns zod JSON Schema into form fields', () => {
    const fields = settingsFields(schema);
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ['volume', 'number'],
      ['enabled', 'boolean'],
      ['mode', 'enum'],
      ['greeting', 'string'],
      ['email', 'string'],
      ['count', 'number'],
      ['banned', 'list'],
      ['limits', 'object'],
      ['either', 'unsupported'],
      ['title', 'string'],
    ]);
    expect(fields[0]).toMatchObject({
      label: 'Volume',
      help: 'How loud alerts play',
      minimum: 0,
      maximum: 100,
      integer: false,
      required: false,
      hasDefault: true,
    });
    expect(fields[2]).toMatchObject({ options: ['chat', 'whisper'] });
    expect(fields[3]).toMatchObject({ maxLength: 200, hasDefault: false, required: false });
    expect(fields[4]).toMatchObject({ format: 'email' });
    // zod's safe-integer bounds are not shown as limits
    expect(fields[5]).toMatchObject({ integer: true });
    expect(fields[5]).not.toHaveProperty('minimum');
    expect(fields[7]).toMatchObject({
      fields: [
        { key: 'perMinute', path: ['limits', 'perMinute'], label: 'Per minute', minimum: 1 },
      ],
    });
    expect(fields[9]).toMatchObject({ label: 'Stream title', required: true });
    expect(settingsFields(null)).toEqual([]);
  });

  it('humanizes keys', () => {
    expect(humanize('perMinute')).toBe('Per minute');
    expect(humanize('api_key')).toBe('Api key');
  });
});

describe('choice fields', () => {
  it('turns choice() fields into choice specs', () => {
    const schema = z.toJSONSchema(
      z.object({ counter: choice('counter.options').describe('Counter') }),
      { io: 'input' },
    ) as Record<string, unknown>;
    expect(settingsFields(schema)).toEqual([
      {
        key: 'counter',
        path: ['counter'],
        label: 'Counter',
        help: 'Counter',
        required: true,
        hasDefault: false,
        kind: 'choice',
        rpc: 'counter.options',
      },
    ]);
  });
});

describe('form values', () => {
  it('sets nested paths without touching siblings and removes cleared values', () => {
    const values = { a: 1, nested: { keep: true, x: 2 } };
    expect(setPath(values, ['nested', 'x'], 3)).toEqual({ a: 1, nested: { keep: true, x: 3 } });
    expect(setPath(values, ['a'], undefined)).toEqual({ nested: { keep: true, x: 2 } });
    expect(values).toEqual({ a: 1, nested: { keep: true, x: 2 } });
  });

  it('patches only editable top-level fields', () => {
    const fields = settingsFields(schema);
    const patch = patchOf(fields, {
      volume: 70,
      either: 'kept on the server',
      limits: { perMinute: 5, hidden: 1 },
      unknownKey: true,
    });
    expect(patch).toEqual({ volume: 70, limits: { perMinute: 5, hidden: 1 } });
  });
});
