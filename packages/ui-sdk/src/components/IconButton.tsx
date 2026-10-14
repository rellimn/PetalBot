import type { ComponentProps } from 'react';
import styles from './Button.module.css';
import type { ButtonVariant } from './Button.tsx';
import { cx, type IconComponent } from './icon.ts';

export interface IconButtonProps extends ComponentProps<'button'> {
  /** Accessible name and tooltip. */
  readonly label: string;
  readonly icon: IconComponent;
  readonly variant?: ButtonVariant;
  readonly size?: 'md' | 'sm';
}

export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.button, styles.iconOnly, className)}
      data-variant={variant}
      data-size={size}
    >
      <Icon size={size === 'sm' ? 14 : 16} aria-hidden />
    </button>
  );
}
