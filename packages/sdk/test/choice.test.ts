import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHOICE_META_KEY, Choices, choice, choiceOf } from '../src/choice.ts';

describe('choice', () => {
  it('is a string field that names its RPC, through describe, default, optional and nullable', () => {
    expect(choice('counter.options').parse('a')).toBe('a');
    expect(choiceOf(choice('counter.options'))).toBe('counter.options');
    expect(choiceOf(choice('counter.options').describe('Counter'))).toBe('counter.options');
    expect(choiceOf(choice('counter.options').default('a'))).toBe('counter.options');
    expect(choiceOf(choice('counter.options').describe('C').default('a'))).toBe('counter.options');
    expect(choiceOf(choice('counter.options').optional())).toBe('counter.options');
    expect(choiceOf(choice('counter.options').nullable())).toBe('counter.options');
    expect(choiceOf(z.string())).toBeUndefined();
    expect(choiceOf(z.string().default('x'))).toBeUndefined();
  });

  it('puts the RPC name into the JSON Schema of the field', () => {
    const schema = z.object({ counter: choice('counter.options').describe('Counter') });
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(json.properties.counter).toMatchObject({
      type: 'string',
      description: 'Counter',
      [CHOICE_META_KEY]: 'counter.options',
    });
  });

  it('describes the output of a choices RPC', () => {
    expect(Choices.parse([{ value: 'a', label: 'A' }])).toEqual([{ value: 'a', label: 'A' }]);
    expect(Choices.safeParse([{ value: 'a' }]).success).toBe(false);
  });
});
