import { useState } from 'react';
import {
  ApiError,
  Banner,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  useApi,
  useToast,
} from '@petalbot/ui-sdk';
import { createOverlay, type DeclaredOverlay, type OverlayToken } from '../app/endpoints.ts';
import { errorText } from '../plugins/actions.tsx';
import { SchemaForm } from '../settings/SchemaForm.tsx';
import { patchOf, setPath, settingsFields, type FormValues } from '../settings/schema.ts';
import settingsStyles from '../settings/settings.module.css';
import { formErrors, NO_ERRORS, type FormErrors } from './form-errors.ts';
import styles from './overlays.module.css';

const keyOf = (overlay: DeclaredOverlay): string => `${overlay.pluginId}/${overlay.overlay}`;

export function NewOverlayDialog({
  overlays,
  onCancel,
  onCreated,
}: {
  readonly overlays: readonly DeclaredOverlay[];
  readonly onCancel: () => void;
  readonly onCreated: (token: OverlayToken) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [choice, setChoice] = useState(() => (overlays[0] ? keyOf(overlays[0]) : ''));
  const [name, setName] = useState('');
  const [config, setConfig] = useState<FormValues>({});
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = useState(false);
  const declared = overlays.find((overlay) => keyOf(overlay) === choice);
  const fields = settingsFields(declared?.schema ?? null);

  const create = async (): Promise<void> => {
    if (!declared) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setErrors({ ...NO_ERRORS, name: 'Give the instance a name.' });
      return;
    }
    setBusy(true);
    try {
      onCreated(
        await createOverlay(api, {
          pluginId: declared.pluginId,
          overlay: declared.overlay,
          name: trimmed,
          config: patchOf(fields, config),
        }),
      );
    } catch (error) {
      const mapped = formErrors(error, fields);
      if (mapped) setErrors(mapped);
      else if (!(error instanceof ApiError && error.status === 401)) {
        toast({
          title: 'Creating the instance failed',
          description: errorText(error),
          tone: 'danger',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="New overlay instance"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              void create();
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {errors.form === undefined ? null : <Banner tone="danger">{errors.form}</Banner>}
        <Field label="Overlay">
          <Select
            options={overlays.map((overlay) => ({
              value: keyOf(overlay),
              label: `${overlay.pluginId} › ${overlay.overlay}`,
            }))}
            value={choice}
            disabled={busy}
            onChange={(event) => {
              setChoice(event.target.value);
              setConfig({});
              setErrors(NO_ERRORS);
            }}
          />
        </Field>
        <Field
          label="Name"
          help="Tells instances apart, e.g. the OBS scene."
          {...(errors.name === undefined ? {} : { error: errors.name })}
        >
          <Input
            value={name}
            maxLength={40}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        {fields.length > 0 ? (
          <fieldset className={settingsStyles.fieldset} disabled={busy}>
            <legend>Configuration</legend>
            <SchemaForm
              fields={fields}
              values={config}
              errors={errors.config}
              disabled={busy}
              onChange={(path, value) => {
                setConfig((current) => setPath(current, path, value));
              }}
            />
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}
