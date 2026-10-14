import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { PetalBotError, PluginUnavailableError, ValidationError } from '../src/errors.ts';

describe('errors', () => {
  it('carry a code and the subclass name', () => {
    const error = new PluginUnavailableError('points');
    expect(error).toBeInstanceOf(PetalBotError);
    expect(error.code).toBe('plugin-unavailable');
    expect(error.name).toBe('PluginUnavailableError');
    expect(error.pluginId).toBe('points');
  });

  it('summarises zod issues in ValidationError', () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: 'x' });
    if (parsed.success) throw new Error('expected failure');
    const error = new ValidationError('payload of "points.changed"', parsed.error.issues);
    expect(error.message).toMatch(/^Invalid payload of "points.changed": n: /);
    expect(error.issues).toHaveLength(1);
  });
});
