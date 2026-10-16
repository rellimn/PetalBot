import { describe, expect, it } from 'vitest';
import { Viewer, sourceOf } from '../src/index.ts';

describe('platform types', () => {
  it('splits a connection id into its source', () => {
    expect(sourceOf('twitch:roman')).toEqual({ platform: 'twitch', connection: 'twitch:roman' });
    expect(sourceOf('kick:a:b')).toEqual({ platform: 'kick', connection: 'kick:a:b' });
    expect(() => sourceOf('Twitch:roman')).toThrow(TypeError);
    expect(() => sourceOf('roman')).toThrow(TypeError);
  });

  it('validates viewers with their platform and connection', () => {
    const viewer = {
      id: 'u1',
      login: 'v',
      displayName: 'V',
      platform: 'twitch',
      connection: 'twitch:roman',
    };
    expect(Viewer.parse(viewer)).toEqual(viewer);
    expect(Viewer.safeParse({ ...viewer, connection: 'roman' }).success).toBe(false);
  });
});
