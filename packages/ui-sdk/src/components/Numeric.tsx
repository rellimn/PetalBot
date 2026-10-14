import type { ReactNode } from 'react';

/** Numbers and timers: tabular figures so digits don't jump. */
export function Numeric({ children }: { readonly children: ReactNode }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{children}</span>;
}
