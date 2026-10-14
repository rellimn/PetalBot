import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  DARK_SCHEMES,
  Field,
  LIGHT_SCHEMES,
  Popover,
  Select,
  useApi,
  useToast,
  useUser,
  type ColorMode,
  type DarkScheme,
  type Density,
  type LightScheme,
} from '@petalbot/ui-sdk';
import { useLeave } from '../app/context.ts';
import { usePreferences, useSavePreferences } from '../app/preferences.ts';
import { errorText } from '../plugins/actions.tsx';
import styles from './TopBar.module.css';

export function UserMenu() {
  const user = useUser();
  const api = useApi();
  const toast = useToast();
  const leave = useLeave();
  const preferences = usePreferences();
  const save = useSavePreferences();
  const [loggingOut, setLoggingOut] = useState(false);

  const logOut = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await api.post('/auth/logout');
      leave('/');
    } catch (error) {
      setLoggingOut(false);
      toast({ title: 'Logging out failed', description: errorText(error), tone: 'danger' });
    }
  };

  return (
    <Popover
      label="Account and appearance"
      trigger={
        <button type="button" className={styles.user}>
          {user.name}
          <ChevronDown size={14} aria-hidden />
        </button>
      }
    >
      <p className={styles.popoverText}>
        Logged in as <strong>{user.name}</strong> ({user.role})
      </p>
      <Field label="Mode">
        <Select
          value={preferences.mode}
          options={[
            { value: 'system', label: 'Follow the system' },
            { value: 'dark', label: 'Always dark' },
            { value: 'light', label: 'Always light' },
          ]}
          onChange={(event) => {
            save({ ...preferences, mode: event.target.value as ColorMode });
          }}
        />
      </Field>
      <Field label="Dark scheme">
        <Select
          value={preferences.darkScheme}
          options={DARK_SCHEMES.map((scheme) => ({ value: scheme.id, label: scheme.label }))}
          onChange={(event) => {
            save({ ...preferences, darkScheme: event.target.value as DarkScheme });
          }}
        />
      </Field>
      <Field label="Light scheme">
        <Select
          value={preferences.lightScheme}
          options={LIGHT_SCHEMES.map((scheme) => ({ value: scheme.id, label: scheme.label }))}
          onChange={(event) => {
            save({ ...preferences, lightScheme: event.target.value as LightScheme });
          }}
        />
      </Field>
      <Field label="Density">
        <Select
          value={preferences.density}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          onChange={(event) => {
            save({ ...preferences, density: event.target.value as Density });
          }}
        />
      </Field>
      <Button
        variant="ghost"
        loading={loggingOut}
        onClick={() => {
          void logOut();
        }}
      >
        Log out
      </Button>
    </Popover>
  );
}
