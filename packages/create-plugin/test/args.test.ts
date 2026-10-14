import { describe, expect, it } from 'vitest';
import { USAGE, parseCreateArgs } from '../src/args.ts';

describe('parseCreateArgs', () => {
  it('defaults to a KV plugin with a panel and no overlays', () => {
    expect(parseCreateArgs(['quotes'])).toEqual({
      id: 'quotes',
      panel: true,
      db: false,
      overlays: [],
    });
  });

  it('reads every flag', () => {
    expect(
      parseCreateArgs(['quotes', '--no-panel', '--db', '--overlay', 'box', '--overlay', 'big-box']),
    ).toEqual({ id: 'quotes', panel: false, db: true, overlays: ['box', 'big-box'] });
  });

  it('explains what is wrong', () => {
    expect(() => parseCreateArgs([])).toThrow(USAGE);
    expect(() => parseCreateArgs(['a', 'b'])).toThrow(USAGE);
    expect(() => parseCreateArgs(['quotes', '--nope'])).toThrow(USAGE);
    expect(() => parseCreateArgs(['My_Plugin'])).toThrow('Invalid plugin id "My_Plugin"');
    expect(() => parseCreateArgs(['core'])).toThrow('The plugin id "core" is reserved');
    expect(() => parseCreateArgs(['quotes', '--overlay', 'Box'])).toThrow(
      'Invalid overlay name "Box"',
    );
    expect(() => parseCreateArgs(['quotes', '--overlay', 'box', '--overlay', 'box'])).toThrow(
      'The overlay "box" is listed twice',
    );
  });
});
