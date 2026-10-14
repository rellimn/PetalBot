import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ApiError,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  useApi,
  useToast,
} from '@petalbot/ui-sdk';
import { clearSecret, saveSecret, type PluginSecret } from '../app/endpoints.ts';
import { errorText } from '../plugins/actions.tsx';
import styles from './settings.module.css';

export const secretsKey = (pluginId: string) => ['secrets', pluginId] as const;

/** The owner's view of a plugin's user-settable secrets. Values are write-only. */
export function SecretsCard({
  pluginId,
  secrets,
}: {
  readonly pluginId: string;
  readonly secrets: readonly PluginSecret[];
}) {
  return (
    <Card title="Secrets">
      <ul className={styles.secrets}>
        {secrets.map((secret) => (
          <SecretRow key={secret.name} pluginId={pluginId} secret={secret} />
        ))}
      </ul>
    </Card>
  );
}

function SecretRow({
  pluginId,
  secret,
}: {
  readonly pluginId: string;
  readonly secret: PluginSecret;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const store = (next: PluginSecret): void => {
    queryClient.setQueryData<readonly PluginSecret[]>(secretsKey(pluginId), (list) =>
      list?.map((entry) => (entry.name === next.name ? next : entry)),
    );
  };

  const failed = (error: unknown): void => {
    // A 401 shows the session notice; the input stays as typed.
    if (error instanceof ApiError && error.status === 401) return;
    toast({ title: 'Saving failed', description: errorText(error), tone: 'danger' });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await saveSecret(api, pluginId, secret.name, value);
      store(next);
      setEditing(false);
      setValue('');
      toast({ title: `${secret.label} saved`, tone: 'success' });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      await clearSecret(api, pluginId, secret.name);
      store({ ...secret, set: false });
      toast({ title: `${secret.label} cleared`, tone: 'success' });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className={styles.secret} aria-label={secret.label}>
      <div className={styles.secretHead}>
        <span className={styles.secretLabel}>{secret.label}</span>
        <Badge tone={secret.set ? 'success' : 'neutral'}>{secret.set ? 'Set' : 'Not set'}</Badge>
        <div className={styles.secretActions}>
          {editing ? null : (
            <Button
              size="sm"
              onClick={() => {
                setEditing(true);
              }}
            >
              {secret.set ? 'Replace' : 'Set value'}
            </Button>
          )}
          {secret.set ? (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      {secret.description === undefined ? null : (
        <p className={styles.help}>{secret.description}</p>
      )}
      {editing ? (
        <form
          className={styles.secretForm}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={`New value for ${secret.label}`}>
            <Input
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={busy}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </Field>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setValue('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={value.trim() === ''}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Clear ${secret.label}?`}
        message={`${pluginId} can't use it until you set a new value.`}
        confirmLabel="Clear"
        tone="danger"
        busy={busy}
        onConfirm={() => {
          void clear();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </li>
  );
}
