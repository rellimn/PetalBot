import { createContext, useContext, useId, type ReactNode } from 'react';
import styles from './Field.module.css';

interface FieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/** Attributes a control inside a `Field` needs; nothing outside one. */
export function useFieldControl(): Partial<Record<'id' | 'aria-describedby', string>> & {
  'aria-invalid'?: true;
} {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: field.id,
    ...(field.describedBy === undefined ? {} : { 'aria-describedby': field.describedBy }),
    ...(field.invalid ? { 'aria-invalid': true as const } : {}),
  };
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly help?: ReactNode;
  readonly error?: ReactNode;
  /** One Input, Textarea or Select. */
  readonly children: ReactNode;
}

export function Field({ label, help, error, children }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy =
    [help === undefined ? undefined : helpId, error === undefined ? undefined : errorId]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <FieldContext value={{ id, describedBy, invalid: error !== undefined }}>
        {children}
      </FieldContext>
      {help !== undefined ? (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
