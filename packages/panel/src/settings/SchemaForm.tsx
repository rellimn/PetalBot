import { useState } from 'react';
import { Banner, Checkbox, Field, Input, Select, Textarea } from '@petalbot/ui-sdk';
import { useChoices } from '@petalbot/ui-sdk/host';
import { isJson, type FieldSpec, type FormValues } from './schema.ts';
import styles from './settings.module.css';

export interface SchemaFormProps {
  readonly fields: readonly FieldSpec[];
  readonly values: FormValues;
  /** 'a.b' -> message */
  readonly errors: ReadonlyMap<string, string>;
  readonly onChange: (path: readonly string[], value: unknown) => void;
  readonly disabled?: boolean;
}

export function SchemaForm({
  fields,
  values,
  errors,
  onChange,
  disabled = false,
}: SchemaFormProps) {
  return (
    <div className={styles.fields}>
      {fields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={values[field.key]}
          errors={errors}
          onChange={onChange}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function labelOf(field: FieldSpec): string {
  return field.required || field.hasDefault ? field.label : `${field.label} (optional)`;
}

function helpOf(field: FieldSpec): string | undefined {
  const parts = field.help === undefined ? [] : [field.help];
  if (field.kind === 'number') {
    if (field.minimum !== undefined && field.maximum !== undefined) {
      parts.push(`Between ${String(field.minimum)} and ${String(field.maximum)}.`);
    } else if (field.minimum !== undefined) {
      parts.push(`At least ${String(field.minimum)}.`);
    } else if (field.maximum !== undefined) {
      parts.push(`At most ${String(field.maximum)}.`);
    }
  }
  if (field.kind === 'string' && field.maxLength !== undefined) {
    parts.push(`Up to ${String(field.maxLength)} characters.`);
  }
  if (field.kind === 'list') parts.push('One per line.');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

interface ControlProps {
  readonly field: FieldSpec;
  readonly value: unknown;
  readonly errors: ReadonlyMap<string, string>;
  readonly onChange: (path: readonly string[], value: unknown) => void;
  readonly disabled: boolean;
}

function FieldControl({ field, value, errors, onChange, disabled }: ControlProps) {
  const error = errors.get(field.path.join('.'));
  const help = helpOf(field);
  const fieldProps = {
    label: labelOf(field),
    ...(help === undefined ? {} : { help }),
    ...(error === undefined ? {} : { error }),
  };
  switch (field.kind) {
    case 'string':
      return (
        <Field {...fieldProps}>
          <Input
            type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value;
              onChange(field.path, text === '' && !field.required ? undefined : text);
            }}
          />
        </Field>
      );
    case 'number':
      return (
        <Field {...fieldProps}>
          <Input
            type="number"
            step={field.integer ? 1 : 'any'}
            value={typeof value === 'number' ? String(value) : ''}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value;
              onChange(field.path, text === '' ? undefined : Number(text));
            }}
          />
        </Field>
      );
    case 'boolean':
      return (
        <div className={styles.check}>
          <Checkbox
            label={field.label}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange(field.path, checked);
            }}
          />
          {help === undefined ? null : <p className={styles.help}>{help}</p>}
          {error === undefined ? null : <p className={styles.error}>{error}</p>}
        </div>
      );
    case 'enum': {
      const blank = value === undefined ? [{ value: '', label: '-' }] : [];
      return (
        <Field {...fieldProps}>
          <Select
            options={[
              ...blank,
              ...field.options.map((option) => ({ value: String(option), label: String(option) })),
            ]}
            value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
            disabled={disabled}
            onChange={(event) => {
              onChange(
                field.path,
                field.options.find((option) => String(option) === event.target.value),
              );
            }}
          />
        </Field>
      );
    }
    case 'choice':
      return (
        <ChoiceControl
          field={field}
          value={value}
          fieldProps={fieldProps}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'list':
      return (
        <ListControl
          field={field}
          value={value}
          fieldProps={fieldProps}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'object':
      return (
        <fieldset className={styles.fieldset} disabled={disabled}>
          <legend>{field.label}</legend>
          {field.help === undefined ? null : <p className={styles.help}>{field.help}</p>}
          <SchemaForm
            fields={field.fields}
            values={isJson(value) ? value : {}}
            errors={errors}
            onChange={onChange}
            disabled={disabled}
          />
        </fieldset>
      );
    case 'unsupported':
      return (
        <Banner>
          {field.label} can&apos;t be edited here ({field.reason}).
        </Banner>
      );
  }
}

function ListControl({
  field,
  value,
  fieldProps,
  disabled,
  onChange,
}: {
  readonly field: Extract<FieldSpec, { kind: 'list' }>;
  readonly value: unknown;
  readonly fieldProps: { label: string; help?: string; error?: string };
  readonly disabled: boolean;
  readonly onChange: (path: readonly string[], value: unknown) => void;
}) {
  // The raw text keeps empty lines while typing; the value never contains them.
  const [text, setText] = useState(() =>
    Array.isArray(value) ? value.map(String).join('\n') : '',
  );
  return (
    <Field {...fieldProps}>
      <Textarea
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const lines = next
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
          onChange(field.path, field.item === 'string' ? lines : lines.map(Number));
        }}
      />
    </Field>
  );
}

function ChoiceControl({
  field,
  value,
  fieldProps,
  disabled,
  onChange,
}: {
  readonly field: Extract<FieldSpec, { kind: 'choice' }>;
  readonly value: unknown;
  readonly fieldProps: { label: string; help?: string; error?: string };
  readonly disabled: boolean;
  readonly onChange: (path: readonly string[], value: unknown) => void;
}) {
  const choices = useChoices(field.rpc);
  const current = typeof value === 'string' ? value : '';
  const list = choices.data ?? [];
  const known = list.some((choice) => choice.value === current);
  const options = [
    ...(current === '' || !field.required ? [{ value: '', label: '-' }] : []),
    // A stored value the RPC no longer lists stays visible instead of silently changing.
    ...(current !== '' && !known && choices.data !== undefined
      ? [{ value: current, label: `Unknown: ${current}` }]
      : []),
    ...list,
  ];
  return (
    <Field
      {...fieldProps}
      {...(choices.isError
        ? { error: `Could not load the choices: ${choices.error.message}` }
        : {})}
    >
      <Select
        options={options}
        value={current}
        disabled={disabled || choices.isPending}
        onChange={(event) => {
          const next = event.target.value;
          onChange(field.path, next === '' ? undefined : next);
        }}
      />
    </Field>
  );
}
