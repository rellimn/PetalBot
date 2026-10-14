import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  isDarkScheme,
  resolveScheme,
} from '../src/theme/appearance.ts';

describe('appearance', () => {
  it('follows the system by default and can force a mode', () => {
    expect(resolveScheme(DEFAULT_APPEARANCE, true)).toBe('rose');
    expect(resolveScheme(DEFAULT_APPEARANCE, false)).toBe('light');
    const custom = { ...DEFAULT_APPEARANCE, darkScheme: 'lavender', lightScheme: 'cream' } as const;
    expect(resolveScheme({ ...custom, mode: 'dark' }, false)).toBe('lavender');
    expect(resolveScheme({ ...custom, mode: 'light' }, true)).toBe('cream');
    expect(isDarkScheme('peach-blossom')).toBe(true);
    expect(isDarkScheme('cream')).toBe(false);
  });

  it('writes the scheme, density and color-scheme onto the root element', () => {
    const root = document.createElement('html');
    applyAppearance(root, { ...DEFAULT_APPEARANCE, mode: 'light', density: 'compact' }, true);
    expect(root.dataset.scheme).toBe('light');
    expect(root.dataset.density).toBe('compact');
    expect(root.style.colorScheme).toBe('light');
  });
});
