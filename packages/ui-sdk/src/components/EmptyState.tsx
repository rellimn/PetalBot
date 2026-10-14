import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <p className={styles.title}>{title}</p>
      {children !== undefined ? <div className={styles.text}>{children}</div> : null}
      {action !== undefined ? <div>{action}</div> : null}
    </div>
  );
}
