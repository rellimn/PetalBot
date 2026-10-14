import { Card, Spinner, usePlugin, useUser } from '@petalbot/ui-sdk';
import type { WidgetRef } from '../app/endpoints.ts';
import { hasRole } from '../app/roles.ts';
import { PluginBoundary } from '../plugins/PluginBoundary.tsx';
import { useKnownPanel, usePanel } from '../plugins/registry.ts';
import styles from './dashboard.module.css';

function Placeholder({ text }: { readonly text: string }) {
  return (
    <Card className={styles.placeholder}>
      <p>{text}</p>
    </Card>
  );
}

/** One widget slot. Missing or stopped widgets keep their slot as a muted placeholder. */
export function WidgetFrame({ widgetRef }: { readonly widgetRef: WidgetRef }) {
  const info = usePlugin(widgetRef.plugin);
  const state = usePanel(widgetRef.plugin);
  const known = useKnownPanel(widgetRef.plugin);
  const user = useUser();
  const loaded = state?.status === 'ready' ? state.panel : undefined;
  const widget = (loaded ?? known)?.widgets.find((candidate) => candidate.id === widgetRef.widget);
  const title = widget?.title ?? `${widgetRef.plugin} / ${widgetRef.widget}`;

  if (info?.state !== 'running') return <Placeholder text={`${title} — plugin not running`} />;
  if (!state || state.status === 'loading') {
    return (
      <Card title={title}>
        <Spinner label={`Loading ${title}`} />
      </Card>
    );
  }
  if (state.status === 'error') return <Placeholder text={`${title} — could not be loaded`} />;
  const current = state.panel.widgets.find((candidate) => candidate.id === widgetRef.widget);
  if (!current) return <Placeholder text={`${title} — this widget no longer exists`} />;
  if (!hasRole(user.role, current.minRole ?? 'owner')) {
    return <Placeholder text={`${title} — not available to you`} />;
  }
  return (
    <Card title={current.title}>
      <PluginBoundary key={state.entry} pluginId={widgetRef.plugin} label={current.title}>
        <current.component />
      </PluginBoundary>
    </Card>
  );
}
