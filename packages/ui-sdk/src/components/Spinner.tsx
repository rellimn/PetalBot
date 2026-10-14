import styles from './Spinner.module.css';

export interface SpinnerProps {
  readonly size?: number;
  /** Accessible label; `null` hides the spinner from assistive technology. Default 'Loading'. */
  readonly label?: string | null;
}

export function Spinner({ size = 18, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size }}
      {...(label === null ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label })}
    />
  );
}
