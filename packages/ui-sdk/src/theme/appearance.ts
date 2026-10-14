export const DARK_SCHEMES = [
  { id: 'rose', label: 'Rose' },
  { id: 'lavender', label: 'Lavender' },
  { id: 'spring-leaf', label: 'Spring Leaf' },
  { id: 'peach-blossom', label: 'Peach Blossom' },
  { id: 'dark-gray', label: 'Dark Gray' },
] as const;

export const LIGHT_SCHEMES = [
  { id: 'light', label: 'Light' },
  { id: 'cream', label: 'Cream' },
] as const;

export type DarkScheme = (typeof DARK_SCHEMES)[number]['id'];
export type LightScheme = (typeof LIGHT_SCHEMES)[number]['id'];
export type Scheme = DarkScheme | LightScheme;
export type ColorMode = 'system' | 'dark' | 'light';
export type Density = 'comfortable' | 'compact';

export interface Appearance {
  readonly darkScheme: DarkScheme;
  readonly lightScheme: LightScheme;
  readonly mode: ColorMode;
  readonly density: Density;
}

export const DEFAULT_APPEARANCE: Appearance = {
  darkScheme: 'rose',
  lightScheme: 'light',
  mode: 'system',
  density: 'comfortable',
};

/** Color tokens every scheme defines. */
export const COLOR_TOKENS = [
  '--pb-bg',
  '--pb-surface-1',
  '--pb-surface-2',
  '--pb-surface-3',
  '--pb-border',
  '--pb-text',
  '--pb-text-muted',
  '--pb-accent',
  '--pb-accent-fg',
  '--pb-accent-text',
  '--pb-brand',
  '--pb-success',
  '--pb-warning',
  '--pb-danger',
  '--pb-danger-fg',
  '--pb-focus-ring',
  '--pb-backdrop',
] as const;

/** Size tokens both densities define. */
export const DENSITY_TOKENS = [
  '--pb-font-size',
  '--pb-font-size-sm',
  '--pb-font-size-lg',
  '--pb-font-size-xl',
  '--pb-line-height',
  '--pb-space-1',
  '--pb-space-2',
  '--pb-space-3',
  '--pb-space-4',
  '--pb-space-5',
  '--pb-row-pad-y',
  '--pb-row-pad-x',
  '--pb-row-gap',
  '--pb-control-height',
  '--pb-topbar-height',
  '--pb-sidebar-width',
] as const;

export function isDarkScheme(scheme: Scheme): scheme is DarkScheme {
  return DARK_SCHEMES.some((entry) => entry.id === scheme);
}

/** The scheme to show: the dark one when the mode (or, for 'system', the browser) says dark. */
export function resolveScheme(appearance: Appearance, prefersDark: boolean): Scheme {
  const dark = appearance.mode === 'dark' || (appearance.mode === 'system' && prefersDark);
  return dark ? appearance.darkScheme : appearance.lightScheme;
}

/** Sets `data-scheme`, `data-density` and `color-scheme` on the root element. */
export function applyAppearance(
  root: HTMLElement,
  appearance: Appearance,
  prefersDark: boolean,
): void {
  const scheme = resolveScheme(appearance, prefersDark);
  root.dataset.scheme = scheme;
  root.dataset.density = appearance.density;
  root.style.colorScheme = isDarkScheme(scheme) ? 'dark' : 'light';
}
