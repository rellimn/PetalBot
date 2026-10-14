import type { ComponentType } from 'react';

/** An icon component such as those of `lucide-react`. */
export type IconComponent = ComponentType<{ size?: number | string; 'aria-hidden'?: boolean }>;

export const cx = (...names: (string | false | undefined)[]): string =>
  names.filter(Boolean).join(' ');
