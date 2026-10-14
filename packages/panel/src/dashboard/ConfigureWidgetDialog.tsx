import { useId, useState } from 'react';
import { z } from 'zod';
import { ValidationError } from '@petalbot/sdk';
import { Button, Dialog, type PanelWidget } from '@petalbot/ui-sdk';
import type { WidgetInstance } from '../app/endpoints.ts';
import { useKnownPanel, usePanel } from '../plugins/registry.ts';
import { SchemaForm } from '../settings/SchemaForm.tsx';
import { patchOf, setPath, settingsFields, type FormValues } from '../settings/schema.ts';

const NO_CONFIG = z.object({});

export interface ConfigureWidgetDialogProps {
  readonly widget: PanelWidget;
  readonly title: string;
  /** The stored config (input form), or undefined for a new instance. */
  readonly stored: Readonly<Record<string, unknown>> | undefined;
  /** Stores the config; the caller closes the dialog when it succeeded. */
  readonly onSave: (config: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly onCancel: () => void;
}

/** The widget's own configure form, or a form generated from its config schema. */
export function ConfigureWidgetDialog({
  widget,
  title,
  stored,
  onSave,
  onCancel,
}: ConfigureWidgetDialogProps) {
  const formId = useId();
  const schema = widget.config ?? NO_CONFIG;
  const [values, setValues] = useState<FormValues>(stored ?? {});
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  const save = async (input: Readonly<Record<string, unknown>>): Promise<void> => {
    const result = schema.safeParse(input);
    if (!result.success) {
      setErrors(
        new Map(
          result.error.issues.map((issue) => [issue.path.map(String).join('.'), issue.message]),
        ),
      );
      throw new ValidationError('widget config', result.error.issues);
    }
    setSaving(true);
    try {
      await onSave(input);
    } finally {
      setSaving(false);
    }
  };
  const close = (open: boolean): void => {
    if (!open) onCancel();
  };

  const Custom = widget.configure;
  if (Custom) {
    const current = schema.safeParse(stored ?? {});
    return (
      <Dialog open onOpenChange={close} title={`Configure ${title}`}>
        <Custom config={current.success ? current.data : undefined} save={save} cancel={onCancel} />
      </Dialog>
    );
  }
  const fields = settingsFields(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  return (
    <Dialog
      open
      onOpenChange={close}
      title={`Configure ${title}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          // Validation problems are shown on the fields; nothing else to report here.
          save(patchOf(fields, values)).catch(() => undefined);
        }}
      >
        <SchemaForm
          fields={fields}
          values={values}
          errors={errors}
          onChange={(path, value) => {
            setValues((current) => setPath(current, path, value));
          }}
        />
      </form>
    </Dialog>
  );
}

/** Configures a placed instance; renders nothing while its widget is unknown. */
export function ConfigureInstanceDialog({
  instance,
  onSave,
  onCancel,
}: {
  readonly instance: WidgetInstance;
  readonly onSave: (config: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const state = usePanel(instance.plugin);
  const known = useKnownPanel(instance.plugin);
  const panel = state?.status === 'ready' ? state.panel : known;
  const widget = panel?.widgets.find((candidate) => candidate.id === instance.widget);
  if (!widget) return null;
  return (
    <ConfigureWidgetDialog
      widget={widget}
      title={widget.title}
      stored={instance.config}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}
