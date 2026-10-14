import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}
