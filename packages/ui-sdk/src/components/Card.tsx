import { useId, type ReactNode } from 'react';
import styles from './Card.module.css';
import { cx } from './icon.ts';

export interface CardProps {
  readonly title?: ReactNode;
  /** Buttons shown at the right of the title. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string | undefined;
}

export function Card({ title, actions, children, className }: CardProps) {
  const titleId = useId();
  return (
    <section
      className={cx(styles.card, className)}
      {...(title === undefined ? {} : { 'aria-labelledby': titleId })}
    >
      {title !== undefined || actions !== undefined ? (
        <header className={styles.header}>
          {title !== undefined ? (
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
          ) : null}
          {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
