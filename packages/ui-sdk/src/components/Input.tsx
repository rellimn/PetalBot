import { useId, type ComponentProps, type ReactNode } from 'react';
import { useFieldControl } from './Field.tsx';
import { cx } from './icon.ts';
import styles from './Input.module.css';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  const control = useFieldControl();
  return <input {...control} {...rest} className={cx(styles.control, className)} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  const control = useFieldControl();
  return (
    <textarea {...control} {...rest} className={cx(styles.control, styles.textarea, className)} />
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<ComponentProps<'select'>, 'children'> {
  readonly options: readonly SelectOption[];
}

export function Select({ options, className, ...rest }: SelectProps) {
  const control = useFieldControl();
  return (
    <select {...control} {...rest} className={cx(styles.control, styles.select, className)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface CheckboxProps {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

export function Checkbox({ label, checked, onCheckedChange, disabled = false }: CheckboxProps) {
  const id = useId();
  return (
    <span className={styles.checkbox}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
      />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}
