import { useNavigate } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Menu,
  Switch,
  useApi,
  useConnection,
  usePlugins,
  useStore,
  useToast,
  type DiscoveryProblem,
  type PluginInfo,
  type Tone,
} from '@petalbot/ui-sdk';
import { deletePluginData, rescanPlugins } from '../app/endpoints.ts';
import { OwnerOnly } from '../app/OwnerOnly.tsx';
import { errorText, usePluginActions } from '../plugins/actions.tsx';
import styles from './admin.module.css';

export function useDiscoveryProblems(): readonly DiscoveryProblem[] {
  const connection = useConnection();
  return useStore(connection.state, (state) => state.problems);
}

function stateOf(info: PluginInfo): { label: string; tone: Tone } {
  switch (info.state) {
    case 'running':
      return info.degraded
        ? { label: 'running · degraded', tone: 'warning' }
        : { label: 'running', tone: 'success' };
    case 'failed':
      return { label: 'failed', tone: 'danger' };
    case 'disabled':
      return { label: 'disabled', tone: 'neutral' };
    case 'starting':
      return { label: 'starting...', tone: 'accent' };
    case 'stopping':
      return { label: 'stopping...', tone: 'accent' };
  }
}

export function PluginsPage() {
  return (
    <OwnerOnly>
      <PluginsContent />
    </OwnerOnly>
  );
}

function PluginsContent() {
  const api = useApi();
  const toast = useToast();
  const connection = useConnection();
  const navigate = useNavigate();
  const plugins = usePlugins();
  const problems = useDiscoveryProblems();
  const actions = usePluginActions();
  const [rescanning, setRescanning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const rows = [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id));

  const rescan = async (): Promise<void> => {
    setRescanning(true);
    try {
      await rescanPlugins(api);
      await connection.refreshPlugins();
    } catch (error) {
      toast({ title: 'Rescan failed', description: errorText(error), tone: 'danger' });
    } finally {
      setRescanning(false);
    }
  };

  const deleteData = async (id: string): Promise<void> => {
    setDeleteBusy(true);
    try {
      const result = await deletePluginData(api, id);
      toast({
        title: `Deleted the data of ${id}`,
        description: `${String(result.droppedTables.length)} tables, ${String(result.overlayInstances)} overlay instances`,
        tone: 'success',
      });
      setDeleting(null);
    } catch (error) {
      toast({
        title: `Could not delete the data of ${id}`,
        description: errorText(error),
        tone: 'danger',
      });
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Plugins</h1>
        <Button
          icon={RefreshCw}
          loading={rescanning}
          onClick={() => {
            void rescan();
          }}
        >
          Rescan
        </Button>
      </header>
      {problems.length > 0 ? (
        <Banner tone="warning">
          <div>
            {problems.length === 1
              ? '1 folder could not be read'
              : `${String(problems.length)} folders could not be read`}
          </div>
          <ul className={styles.problems}>
            {problems.map((problem) => (
              <li key={problem.dir}>
                <code>{problem.dir}</code> {problem.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="No plugins">
          Put plugin folders into a plugin directory and press Rescan.
        </EmptyState>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Plugin</th>
              <th scope="col">Version</th>
              <th scope="col">State</th>
              <th scope="col">Enabled</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((info) => {
              const state = stateOf(info);
              const moving = info.state === 'starting' || info.state === 'stopping';
              return (
                <Fragment key={info.id}>
                  <tr>
                    <td>{info.id}</td>
                    <td className={styles.muted}>{info.version}</td>
                    <td>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </td>
                    <td>
                      <Switch
                        label={`${info.id} enabled`}
                        checked={info.enabled}
                        disabled={moving || actions.busy === info.id}
                        onCheckedChange={(on) => {
                          void actions.run(on ? 'enable' : 'disable', info.id);
                        }}
                      />
                    </td>
                    <td>
                      <Menu
                        label={`Actions for ${info.id}`}
                        items={[
                          {
                            label: 'Reload',
                            disabled: info.state !== 'running',
                            onSelect: () => {
                              void actions.run('reload', info.id);
                            },
                          },
                          {
                            label: 'Settings',
                            onSelect: () => {
                              void navigate({
                                to: '/settings/$pluginId',
                                params: { pluginId: info.id },
                              });
                            },
                          },
                          {
                            label: 'Delete data...',
                            tone: 'danger',
                            disabled: info.enabled,
                            onSelect: () => {
                              setDeleting(info.id);
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                  {info.state === 'failed' && info.error !== undefined ? (
                    <tr>
                      <td colSpan={5} className={styles.errorRow}>
                        ↳ {info.error}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {actions.dialog}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          title={`Delete all data of ${deleting}?`}
          message="Its tables, stored values, settings, secrets and overlay instances are deleted. This cannot be undone."
          confirmLabel="Delete data"
          tone="danger"
          requireText={deleting}
          busy={deleteBusy}
          onConfirm={() => {
            void deleteData(deleting);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
