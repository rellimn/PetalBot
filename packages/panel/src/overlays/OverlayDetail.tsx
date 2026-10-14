import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  ApiError,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  useApi,
  usePlugin,
  useToast,
} from '@petalbot/ui-sdk';
import {
  revokeOverlay,
  rotateOverlay,
  updateOverlay,
  type DeclaredOverlay,
  type OverlayInstance,
} from '../app/endpoints.ts';
import { errorText } from '../plugins/actions.tsx';
import { SchemaForm } from '../settings/SchemaForm.tsx';
import { patchOf, setPath, settingsFields, type FormValues } from '../settings/schema.ts';
import settingsStyles from '../settings/settings.module.css';
import { formErrors, NO_ERRORS, type FormErrors } from './form-errors.ts';
import { overlaysKey } from './keys.ts';
import { OverlayPreview } from './OverlayPreview.tsx';
import styles from './overlays.module.css';

export interface OverlayDetailProps {
  readonly instance: OverlayInstance;
  /** The running plugin's declaration of this overlay; undefined while it is not running. */
  readonly declared: DeclaredOverlay | undefined;
  /** Shows a URL with its token once (after rotating). */
  readonly onUrl: (title: string, url: string) => void;
}

const previewUrl = (instance: OverlayInstance): string =>
  `/overlay/${encodeURIComponent(instance.pluginId)}/${encodeURIComponent(instance.overlay)}/${encodeURIComponent(instance.id)}?preview`;

export function OverlayDetail({ instance, declared, onUrl }: OverlayDetailProps) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pluginRunning = usePlugin(instance.pluginId)?.state === 'running';
  const editable = pluginRunning && declared !== undefined;
  const fields = settingsFields(declared?.schema ?? null);
  const [name, setName] = useState(instance.name);
  const [config, setConfig] = useState<FormValues>(instance.config);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: overlaysKey });
  const fail = (title: string, error: unknown): void => {
    // A 401 shows the session notice instead; the typed input stays.
    if (error instanceof ApiError && error.status === 401) return;
    toast({ title, description: errorText(error), tone: 'danger' });
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setErrors({ ...NO_ERRORS, name: 'Give the instance a name.' });
      return;
    }
    setSaving(true);
    try {
      await updateOverlay(api, instance.id, {
        name: trimmed,
        // PATCH replaces the config: keep stored values the form cannot render (e.g. lists).
        ...(editable ? { config: { ...instance.config, ...patchOf(fields, config) } } : {}),
      });
      setErrors(NO_ERRORS);
      toast({ title: 'Saved', tone: 'success' });
      void refresh();
    } catch (error) {
      const mapped = formErrors(error, fields);
      if (mapped) setErrors(mapped);
      else fail('Saving failed', error);
    } finally {
      setSaving(false);
    }
  };

  const rotate = async (): Promise<void> => {
    setBusy(true);
    try {
      const token = await rotateOverlay(api, instance.id);
      setConfirm(null);
      onUrl(`New URL for ${instance.name}`, token.url);
      void refresh();
    } catch (error) {
      fail('Rotating the token failed', error);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await revokeOverlay(api, instance.id);
      setConfirm(null);
      toast({ title: `Revoked ${instance.name}`, tone: 'success' });
      void navigate({ to: '/admin/overlays' });
      void refresh();
    } catch (error) {
      fail('Revoking failed', error);
    } finally {
      setBusy(false);
    }
  };

  let configuration: ReactNode;
  if (!pluginRunning) {
    configuration = (
      <Banner>
        {instance.pluginId} is not running. The configuration and the preview are available while it
        runs.
      </Banner>
    );
  } else if (!declared) {
    configuration = (
      <Banner tone="warning">
        {instance.pluginId} no longer declares the overlay &quot;{instance.overlay}&quot;. Revoke
        this instance or update the plugin.
      </Banner>
    );
  } else if (fields.length === 0) {
    configuration = <p className={styles.muted}>This overlay has no settings.</p>;
  } else {
    configuration = (
      <fieldset className={settingsStyles.fieldset} disabled={saving}>
        <legend>Configuration</legend>
        <SchemaForm
          fields={fields}
          values={config}
          errors={errors.config}
          disabled={saving}
          onChange={(path, value) => {
            setConfig((current) => setPath(current, path, value));
          }}
        />
      </fieldset>
    );
  }

  return (
    <Card
      title={instance.name}
      actions={
        <>
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              setConfirm('rotate');
            }}
          >
            Rotate token
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            onClick={() => {
              setConfirm('revoke');
            }}
          >
            Revoke
          </Button>
        </>
      }
    >
      <p className={styles.meta}>
        {instance.pluginId} {'>'} {instance.overlay}
      </p>
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {errors.form === undefined ? null : <Banner tone="danger">{errors.form}</Banner>}
        <Field
          label="Name"
          help="Tells instances apart, e.g. the OBS scene."
          {...(errors.name === undefined ? {} : { error: errors.name })}
        >
          <Input
            value={name}
            maxLength={40}
            disabled={saving}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        {configuration}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
        </div>
      </form>
      {editable && !declared.hasBundle ? (
        <Banner tone="warning">
          {instance.pluginId} has no built bundle for this overlay, so it shows nothing. Build the
          plugin.
        </Banner>
      ) : null}
      {editable ? (
        <OverlayPreview src={previewUrl(instance)} title={`Preview of ${instance.name}`} />
      ) : null}
      <ConfirmDialog
        open={confirm === 'rotate'}
        title={`Rotate the token of ${instance.name}?`}
        message="The current URL stops working at once. Put the new URL into the OBS browser source."
        confirmLabel="Rotate token"
        busy={busy}
        onConfirm={() => {
          void rotate();
        }}
        onCancel={() => {
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'revoke'}
        title={`Revoke ${instance.name}?`}
        message="Its URL stops working at once and the instance is deleted. This cannot be undone."
        confirmLabel="Revoke"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          void revoke();
        }}
        onCancel={() => {
          setConfirm(null);
        }}
      />
    </Card>
  );
}
