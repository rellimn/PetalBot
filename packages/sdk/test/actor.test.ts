import { describe, expect, it } from 'vitest';
import { describeActor } from '../src/index.ts';

describe('describeActor', () => {
  it('describes every kind of actor', () => {
    expect(describeActor({ kind: 'user', user: { id: '1', name: 'mia', role: 'mod' } })).toBe(
      'mia',
    );
    expect(describeActor({ kind: 'overlay', instanceId: 'i1' })).toBe('overlay');
    expect(describeActor({ kind: 'plugin', pluginId: 'counter' })).toBe('counter');
    expect(
      describeActor({
        kind: 'viewer',
        viewer: {
          id: 'u1',
          login: 'v',
          displayName: 'Viewer',
          platform: 'twitch',
          connection: 'twitch:roman',
        },
      }),
    ).toBe('Viewer');
    expect(describeActor({ kind: 'flow', flowId: 'f1', name: 'Raid welcome' })).toBe(
      'Raid welcome',
    );
  });
});
