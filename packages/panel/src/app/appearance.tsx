import { useEffect, useSyncExternalStore } from 'react';
import { applyAppearance } from '@petalbot/ui-sdk';
import { usePreferences } from './preferences.ts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(DARK_QUERY).matches);
}

/** Keeps `data-scheme`/`data-density` on <html> in sync with the user's preferences. */
export function Appearance() {
  const preferences = usePreferences();
  const prefersDark = usePrefersDark();
  useEffect(() => {
    applyAppearance(document.documentElement, preferences, prefersDark);
  }, [preferences, prefersDark]);
  return null;
}
