import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  ApiError,
  Banner,
  Button,
  EmptyState,
  Spinner,
  useApi,
  usePlugin,
  useToast,
} from '@petalbot/ui-sdk';
import { loadSettings, saveSettings, type PluginSettings } from '../app/endpoints.ts';
import { OwnerOnly } from '../app/OwnerOnly.tsx';
import { errorText } from '../plugins/actions.tsx';
import { PluginBoundary } from '../plugins/PluginBoundary.tsx';
import { usePanel } from '../plugins/registry.ts';
import { SchemaForm } from './SchemaForm.tsx';
import { fieldPaths, patchOf, setPath, settingsFields, type FormValues } from './schema.ts';
import styles from './settings.module.css';

export const settingsKey = (pluginId: string) => ['settings', pluginId] as const;

export function SettingsPage() {
  return (
    <OwnerOnly>
      <SettingsContent />
    </OwnerOnly>
  );
}

function SettingsContent() {
  const { pluginId } = useParams({ from: '/settings/$pluginId' });
  const api = useApi();
  const queryClient = useQueryClient();
  const info = usePlugin(pluginId);
  const panel = usePanel(pluginId);
  const query = useQuery({
    queryKey: settingsKey(pluginId),
    queryFn: () => loadSettings(api, pluginId),
  });

  const title = `${pluginId.charAt(0).toUpperCase()}${pluginId.slice(1)} settings`;
  let content: ReactNode;
  if (query.isPending) {
    content = <Spinner label="Loading settings" />;
  } else if (query.isError) {
    content = (
      <EmptyState title="Settings could not be loaded">{errorText(query.error)}</EmptyState>
    );
  } else if (query.data.schema === null) {
    content = <EmptyState title="No settings">{pluginId} has no settings.</EmptyState>;
  } else {
    const Custom =
      info?.state === 'running' && panel?.status === 'ready' ? panel.panel.settings : undefined;
    const settings = query.data;
    content = Custom ? (
      <PluginBoundary pluginId={pluginId} label="Settings">
        <Custom
          values={settings.values}
          schema={settings.schema}
          save={async (patch) => {
            const saved = await saveSettings(api, pluginId, patch);
            queryClient.setQueryData(settingsKey(pluginId), { ...settings, values: saved });
            return saved;
          }}
        />
      </PluginBoundary>
    ) : (
      <GeneratedSettings key={pluginId} pluginId={pluginId} settings={settings} />
    );
  }
  return (
    <div className={styles.page}>
      <h1>{title}</h1>
      {content}
    </div>
  );
}

function GeneratedSettings({
  pluginId,
  settings,
}: {
  readonly pluginId: string;
  readonly settings: PluginSettings;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fields = settingsFields(settings.schema);
  const [values, setValues] = useState<FormValues>(settings.values);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    try {
      const saved = await saveSettings(api, pluginId, patchOf(fields, values));
      setValues(saved);
      setErrors(new Map());
      queryClient.setQueryData(settingsKey(pluginId), { ...settings, values: saved });
      toast({ title: 'Settings saved', tone: 'success' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'validation') {
        setErrors(new Map(error.issues.map((issue) => [issue.path.join('.'), issue.message])));
        const known = new Set(fieldPaths(fields));
        const other = error.issues
          .filter((issue) => !known.has(issue.path.join('.')))
          .map((issue) => issue.message);
        setFormError(other.length > 0 ? other.join(' ') : 'Some values are not valid.');
      } else if (!(error instanceof ApiError && error.status === 401)) {
        // A 401 shows the session notice; the input stays as typed.
        toast({ title: 'Saving failed', description: errorText(error), tone: 'danger' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {formError === null ? null : <Banner tone="danger">{formError}</Banner>}
      <SchemaForm
        fields={fields}
        values={values}
        errors={errors}
        disabled={saving}
        onChange={(path, value) => {
          setValues((current) => setPath(current, path, value));
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}
