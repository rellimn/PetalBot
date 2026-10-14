import { useState, type ReactNode } from 'react';
import { ApiError, ConfirmDialog, useApi, useToast } from '@petalbot/ui-sdk';
import { disablePlugin, enablePlugin, reloadPlugin } from '../app/endpoints.ts';

export type PluginAction = 'enable' | 'disable' | 'reload';

interface Confirmation {
  readonly action: 'enable' | 'disable';
  readonly id: string;
  readonly plugins: readonly string[];
}

const DONE: Readonly<Record<PluginAction, string>> = {
  enable: 'Enabled',
  disable: 'Disabled',
  reload: 'Reloaded',
};

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Enable/disable/reload with toasts, asking first when other plugins are affected. */
export function usePluginActions(): {
  run: (action: PluginAction, id: string) => Promise<void>;
  busy: string | null;
  dialog: ReactNode;
} {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const perform = async (action: PluginAction, id: string, confirmed: boolean): Promise<void> => {
    setBusy(id);
    try {
      if (action === 'enable') await enablePlugin(api, id, confirmed);
      else if (action === 'disable') await disablePlugin(api, id, confirmed);
      else await reloadPlugin(api, id);
      toast({ title: `${DONE[action]} ${id}`, tone: 'success' });
    } catch (error) {
      if (
        action !== 'reload' &&
        error instanceof ApiError &&
        error.code === 'confirmation_required'
      ) {
        setConfirmation({ action, id, plugins: error.plugins });
      } else {
        toast({
          title: `Could not ${action} ${id}`,
          description: errorText(error),
          tone: 'danger',
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const dialog =
    confirmation === null ? null : (
      <ConfirmDialog
        open
        title={`${confirmation.action === 'enable' ? 'Enable' : 'Disable'} ${confirmation.id}?`}
        message={
          confirmation.action === 'enable'
            ? `It needs these plugins, which will be enabled too: ${confirmation.plugins.join(', ')}.`
            : `These plugins depend on it and will be disabled too: ${confirmation.plugins.join(', ')}.`
        }
        confirmLabel={`${confirmation.action === 'enable' ? 'Enable' : 'Disable'} all ${String(
          confirmation.plugins.length + 1,
        )}`}
        tone={confirmation.action === 'disable' ? 'danger' : 'primary'}
        onConfirm={() => {
          setConfirmation(null);
          void perform(confirmation.action, confirmation.id, true);
        }}
        onCancel={() => {
          setConfirmation(null);
        }}
      />
    );

  return { run: (action, id) => perform(action, id, false), busy, dialog };
}
