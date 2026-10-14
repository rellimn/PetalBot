import type { ComponentProps } from 'react';
import styles from './Button.module.css';
import { cx, type IconComponent } from './icon.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ComponentProps<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: 'md' | 'sm';
  readonly icon?: IconComponent;
  /** Shows a spinner and disables the button. */
  readonly loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
    >
      {loading ? (
        <Spinner size={14} label={null} />
      ) : Icon ? (
        <Icon size={size === 'sm' ? 14 : 16} aria-hidden />
      ) : null}
      {children}
    </button>
  );
}
