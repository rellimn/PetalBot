import styles from './StatusDot.module.css';

export interface StatusDotProps {
  readonly tone: 'ok' | 'idle' | 'warning' | 'danger';
  /** What the dot means, for assistive technology and as a tooltip. */
  readonly label: string;
  /** Pulse once to draw attention. */
  readonly pulse?: boolean;
}

export function StatusDot({ tone, label, pulse = false }: StatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={styles.dot}
      data-tone={tone}
      data-pulse={pulse || undefined}
    />
  );
}
