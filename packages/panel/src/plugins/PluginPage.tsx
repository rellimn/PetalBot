import { useParams } from '@tanstack/react-router';
import { EmptyState, Spinner, usePlugin, useUser } from '@petalbot/ui-sdk';
import { hasRole } from '../app/roles.ts';
import { NotRunning } from './NotRunning.tsx';
import { PluginBoundary } from './PluginBoundary.tsx';
import styles from './plugins.module.css';
import { usePanel } from './registry.ts';

/** `/p/<pluginId>/<path>`: a page contributed by a plugin bundle. */
export function PluginPage() {
  const params = useParams({ from: '/p/$pluginId/$' });
  const pluginId = params.pluginId;
  const path = params._splat ?? '';
  const info = usePlugin(pluginId);
  const state = usePanel(pluginId);
  const user = useUser();

  if (!info) {
    return <EmptyState title="Unknown plugin">There is no plugin called “{pluginId}”.</EmptyState>;
  }
  if (info.state !== 'running') return <NotRunning info={info} />;
  if (!info.panel) {
    return <EmptyState title="No pages">{pluginId} has no panel pages.</EmptyState>;
  }
  if (!state || state.status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner label={`Loading ${pluginId}`} />
      </div>
    );
  }
  if (state.status === 'error') {
    return <EmptyState title={`${pluginId} could not be loaded`}>{state.message}</EmptyState>;
  }
  const page = state.panel.pages.find((candidate) => candidate.path === path);
  if (!page) {
    return (
      <EmptyState title="Page not found">
        {pluginId} has no page “{path}”.
      </EmptyState>
    );
  }
  if (!hasRole(user.role, page.minRole ?? 'owner')) {
    return <EmptyState title="Not allowed">This page is for owners.</EmptyState>;
  }
  return (
    <div className={styles.page}>
      <h1>{page.title}</h1>
      <PluginBoundary key={state.entry} pluginId={pluginId} label={page.title}>
        <page.component />
      </PluginBoundary>
    </div>
  );
}
