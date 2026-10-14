import type { ReactNode } from 'react';
import styles from './Banner.module.css';

export interface BannerProps {
  readonly tone?: 'info' | 'success' | 'warning' | 'danger';
  readonly children: ReactNode;
  /** A button at the end of the banner. */
  readonly action?: ReactNode;
}

export function Banner({ tone = 'info', children, action }: BannerProps) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className={styles.text}>{children}</div>
      {action !== undefined ? <div>{action}</div> : null}
    </div>
  );
}
