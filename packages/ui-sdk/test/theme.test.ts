import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKENS,
  DARK_SCHEMES,
  DENSITY_TOKENS,
  LIGHT_SCHEMES,
} from '../src/theme/appearance.ts';

// happy-dom replaces the global URL, which fs does not accept.
const css = readFileSync(join(import.meta.dirname, '../src/theme/theme.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('theme.css', () => {
  it('defines every color token in every scheme', () => {
    for (const { id } of [...DARK_SCHEMES, ...LIGHT_SCHEMES]) {
      const body = block(`:root[data-scheme='${id}']`);
      for (const token of COLOR_TOKENS) expect(body, `${id} ${token}`).toContain(`${token}:`);
      expect(body).toContain(
        `color-scheme: ${DARK_SCHEMES.some((s) => s.id === id) ? 'dark' : 'light'}`,
      );
    }
  });

  it('defines every density token for both densities and Rose as the default', () => {
    const comfortable = block(':root');
    const compact = block(":root[data-density='compact']");
    for (const token of DENSITY_TOKENS) {
      expect(comfortable, token).toContain(`${token}:`);
      expect(compact, token).toContain(`${token}:`);
    }
    expect(css).toContain(":root,\n:root[data-scheme='rose'] {");
  });
});
